import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { createTestDb, type TestDb } from './test-db';
import { requireActor, sha256Hex, type ActorContext } from './core';
import {
	createComment,
	createIssue,
	getIssueDetail,
	loadIssueForActor,
	transitionIssue,
	updateIssue
} from './issues';
import { TEST_NOOP_DISPATCH_EFFECTS } from './test-dispatch-effects';
import { createSiteLink, deleteArtifact, reaffirmArtifact, upsertArtifact } from './artifacts';
import { addIssueLabels, removeIssueLabel } from './labels';
import { addIssueLink, removeIssueLink } from './issue-links';
import {
	appendContextItem,
	createContextItem,
	deleteContextItem,
	updateContextItem
} from './context';
import {
	actorForIssue,
	actorForProject,
	assertNotMember,
	resolveProjectAccess,
	runProjectActor,
	runStillBoundPredicate
} from './project-access';
import {
	NOW,
	OPEN,
	PROJECT,
	REVIEW,
	USER,
	addIssue,
	addLabel,
	addMemberContributorRun,
	addRun,
	addRunKey,
	addRunner,
	seedBase
} from '../supervisor/test-fixtures';
import { ownerIssueConsentPredicate } from '../supervisor/consent-admission';
import { supervisorEvent } from '../supervisor/engine';
import { eventQuery, serializeEvent } from './events';
import { sql } from 'kysely';
import { GET as getJournal } from '../../../routes/api/v1/issues/[id]/journal/+server';

const BEARER = 'run-contributor-test-key';

async function setup() {
	const t = createTestDb();
	seedBase(t);
	t.sqlite.exec(`INSERT INTO project (id, user_id, name, created_at, updated_at)
		VALUES ('prj_private', '${USER}', 'private', ${NOW}, ${NOW})`);
	const issueId = addIssue(t, { state: OPEN, title: 'Member work' });
	const run = addMemberContributorRun(t, { issueId, keyHash: await sha256Hex(BEARER) });
	return { t, issueId, ...run };
}

function authenticate(t: TestDb): Promise<ActorContext> {
	return requireActor({
		locals: {},
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request('http://test/api/v1/anything', {
			headers: { authorization: `Bearer ${BEARER}` }
		}),
		url: new URL('http://test/api/v1/anything')
	} as unknown as RequestEvent);
}

async function inactiveReason(t: TestDb): Promise<unknown> {
	const error = await authenticate(t).catch((e) => e);
	expect(error).toMatchObject({ status: 401, code: 'run_key_inactive' });
	return error.details?.reason;
}

describe('run keys are bound to their contributor at authentication', () => {
	it('binds a member run to its contributor, runner and admitted project', async () => {
		const { t, issueId, memberId, runnerId, runId } = await setup();
		const actor = await authenticate(t);
		expect(actor.userId).toBe(memberId);
		expect(actor.runRestriction).toMatchObject({
			runId,
			issueId,
			projectId: PROJECT,
			binding: {
				contributorUserId: memberId,
				projectOwnerId: USER,
				projectOwnerName: 'alice',
				runnerId,
				membershipRevision: 1
			}
		});
	});

	it('binds an owner run with no membership revision', async () => {
		const t = createTestDb();
		seedBase(t);
		const issueId = addIssue(t, { state: OPEN, title: 'Owner work' });
		const runId = addRun(t, { issueId, runnerId: addRunner(t), status: 'running' });
		const keyId = addRunKey(t, runId);
		t.sqlite.prepare('UPDATE api_key SET key_hash = ?, permissions = ? WHERE id = ?').run(
			await sha256Hex(BEARER),
			JSON.stringify({
				version: 1,
				projects: { access: 'write', scope: 'all' },
				workspace: 'write',
				control_plane: 'read'
			}),
			keyId
		);
		const actor = await authenticate(t);
		expect(actor.runRestriction?.binding).toMatchObject({
			contributorUserId: USER,
			projectOwnerId: USER,
			membershipRevision: null
		});
		expect(runProjectActor(actor, PROJECT)).toBeNull();
		t.sqlite.prepare('UPDATE agent_run SET cancel_requested_at = ? WHERE id = ?').run(NOW, runId);
		expect(await inactiveReason(t)).toBe('cancel_requested');
	});

	it('refuses a key, run or runner that names another person', async () => {
		const { t, runId, runnerId, keyId } = await setup();
		t.sqlite.prepare('UPDATE runner SET user_id = ? WHERE id = ?').run(USER, runnerId);
		expect(await inactiveReason(t)).toBe('contributor_mismatch');
		t.sqlite.prepare('UPDATE runner SET user_id = ? WHERE id = ?').run('u_member', runnerId);
		t.sqlite.prepare('UPDATE api_key SET user_id = ? WHERE id = ?').run(USER, keyId);
		expect(await inactiveReason(t)).toBe('contributor_mismatch');
		t.sqlite.prepare('UPDATE api_key SET user_id = ? WHERE id = ?').run('u_member', keyId);
		t.sqlite.prepare('UPDATE agent_run SET user_id = ? WHERE id = ?').run(USER, runId);
		expect(await inactiveReason(t)).toBe('contributor_mismatch');
	});

	it('refuses a run whose cancellation was requested', async () => {
		const { t, runId } = await setup();
		t.sqlite.prepare('UPDATE agent_run SET cancel_requested_at = ? WHERE id = ?').run(NOW, runId);
		expect(await inactiveReason(t)).toBe('cancel_requested');
	});

	it('refuses a run whose issue was transferred', async () => {
		const { t, issueId } = await setup();
		t.sqlite
			.prepare('UPDATE issue SET project_assignment_token = ? WHERE id = ?')
			.run('tok_after_transfer', issueId);
		expect(await inactiveReason(t)).toBe('transferred');
		const other = await setup();
		other.t.sqlite
			.prepare('UPDATE issue SET project_id = ? WHERE id = ?')
			.run('prj_private', other.issueId);
		expect(await inactiveReason(other.t)).toBe('transferred');
	});

	it('refuses a member run after removal, rejoin, unsharing or with no admitted revision', async () => {
		const cases: Array<(t: TestDb, runId: string) => void> = [
			(t) => t.sqlite.prepare('UPDATE project_member SET revoked_at = ?').run(NOW),
			(t) => t.sqlite.prepare('UPDATE project_member SET revision = 3').run(),
			(t) => t.sqlite.prepare('UPDATE project SET shared_at = NULL').run(),
			(t, runId) =>
				t.sqlite
					.prepare('UPDATE agent_run SET admitted_membership_revision = NULL WHERE id = ?')
					.run(runId)
		];
		for (const change of cases) {
			const { t, runId } = await setup();
			change(t, runId);
			expect(await inactiveReason(t)).toBe('membership_changed');
		}
	});
});

describe('a member run acts on its admitted project with the owner scope', () => {
	it('delegates for the admitted project and reads the owner’s issue', async () => {
		const { t, issueId, memberId } = await setup();
		const actor = await authenticate(t);
		const scoped = await actorForIssue(t.db, actor, issueId);
		expect(scoped).toMatchObject({
			userId: USER,
			apiKeyId: actor.apiKeyId,
			agentRunId: actor.agentRunId,
			member: { userId: memberId, projectId: PROJECT, membershipRevision: 1 }
		});
		expect((await loadIssueForActor(t.db, scoped, { id: issueId })).id).toBe(issueId);
		expect(await resolveProjectAccess(t.db, actor, PROJECT)).toMatchObject({
			role: 'member',
			membershipRevision: 1
		});
		expect(() => assertNotMember(scoped, 'Runners')).toThrow(
			expect.objectContaining({ code: 'owner_only' })
		);
	});

	it('does not delegate anywhere else, so the owner’s other projects 404', async () => {
		const { t } = await setup();
		const actor = await authenticate(t);
		expect(runProjectActor(actor, 'prj_private')).toBeNull();
		expect(await actorForProject(t.db, actor, 'prj_private')).toBe(actor);
		// The run fence refuses first; the membership check would 404 behind it.
		await expect(resolveProjectAccess(t.db, actor, 'prj_private')).rejects.toMatchObject({
			status: 403,
			details: expect.objectContaining({ reason: 'outside_run_project' })
		});
	});

	it('leaves account-level resolution on the contributor', async () => {
		const { t, memberId } = await setup();
		const actor = await authenticate(t);
		// Account routes never call the delegate: the run actor is the contributor's.
		expect(actor.userId).toBe(memberId);
		expect(actor.member).toBeUndefined();
		const runners = await t.db
			.selectFrom('runner')
			.select('id')
			.where('user_id', '=', actor.userId)
			.execute();
		expect(runners).toHaveLength(1);
	});
});

async function ownerRunSetup() {
	const t = createTestDb();
	seedBase(t);
	const issueId = addIssue(t, { state: OPEN, title: 'Owner work' });
	const runId = addRun(t, { issueId, runnerId: addRunner(t), status: 'running' });
	const keyId = addRunKey(t, runId);
	t.sqlite.prepare('UPDATE api_key SET key_hash = ?, permissions = ? WHERE id = ?').run(
		await sha256Hex(BEARER),
		JSON.stringify({
			version: 1,
			projects: { access: 'write', scope: 'all' },
			workspace: 'write',
			control_plane: 'read'
		}),
		keyId
	);
	return { t, issueId, runId, keyId };
}

function eventCount(t: TestDb, issueId: string): number {
	return (
		t.sqlite.prepare('SELECT count(*) AS n FROM event WHERE issue_id = ?').get(issueId) as {
			n: number;
		}
	).n;
}

async function bound(t: TestDb, actor: ActorContext): Promise<boolean> {
	const { sql } = await import('kysely');
	const row = await sql<{
		ok: number;
	}>`SELECT ${runStillBoundPredicate(actor)} AS ok`.execute(t.db);
	return !!row.rows[0]?.ok;
}

type Revoke = (t: TestDb, ids: { runId: string; keyId: string; issueId: string }) => void;

const OWNER_REVOCATIONS: Record<string, Revoke> = {
	'cancel requested': (t, { runId }) =>
		t.sqlite.prepare('UPDATE agent_run SET cancel_requested_at = ? WHERE id = ?').run(NOW, runId),
	'run ended': (t, { runId }) =>
		t.sqlite.prepare("UPDATE agent_run SET status = 'completed' WHERE id = ?").run(runId),
	'key revoked': (t, { keyId }) =>
		t.sqlite.prepare('UPDATE api_key SET revoked_at = ? WHERE id = ?').run(NOW, keyId),
	'key expired': (t, { keyId }) =>
		t.sqlite.prepare('UPDATE api_key SET expires_at = ? WHERE id = ?').run(NOW, keyId),
	transferred: (t, { issueId }) =>
		t.sqlite.prepare("UPDATE issue SET project_id = 'prj_private' WHERE id = ?").run(issueId)
};

const MEMBER_REVOCATIONS: Record<string, Revoke> = {
	...OWNER_REVOCATIONS,
	'token changed': (t, { issueId }) =>
		t.sqlite
			.prepare("UPDATE issue SET project_assignment_token = 'tok_moved' WHERE id = ?")
			.run(issueId),
	removed: (t) => t.sqlite.prepare('UPDATE project_member SET revoked_at = ?').run(NOW),
	rejoined: (t) => t.sqlite.prepare('UPDATE project_member SET revision = revision + 2').run(),
	unshared: (t) => t.sqlite.prepare('UPDATE project SET shared_at = NULL').run()
};

describe('run-key writes re-check the binding at commit', () => {
	it('holds for a live owner run and a live member run', async () => {
		const owner = await ownerRunSetup();
		expect(await bound(owner.t, await authenticate(owner.t))).toBe(true);
		const member = await setup();
		expect(await bound(member.t, await authenticate(member.t))).toBe(true);
	});

	for (const [name, revoke] of Object.entries(OWNER_REVOCATIONS)) {
		it(`refuses an owner run's update and transition after: ${name}`, async () => {
			const { t, issueId, runId, keyId } = await ownerRunSetup();
			t.sqlite.exec(`INSERT OR IGNORE INTO project (id, user_id, name, created_at, updated_at)
				VALUES ('prj_private', '${USER}', 'private', ${NOW}, ${NOW})`);
			// Preflight: authenticated while the run was still bound.
			const actor = await authenticate(t);
			const action = (await getIssueDetail(t.db, USER, { id: issueId })).allowed_transitions.find(
				(x) => x.to_state.id === REVIEW
			)!.name;
			revoke(t, { runId, keyId, issueId });
			const events = eventCount(t, issueId);
			expect(await bound(t, actor)).toBe(false);
			// A transfer is also caught by the preflight run fence (403); the rest
			// pass preflight on the stale actor and are refused by the commit guard.
			const refused =
				name === 'transferred'
					? { status: 403, code: 'run_key_forbidden' }
					: { status: 401, code: 'run_key_inactive' };
			await expect(
				updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, issueId, { title: 'late' })
			).rejects.toMatchObject(refused);
			await expect(
				transitionIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, issueId, { action })
			).rejects.toMatchObject(refused);
			const row = t.sqlite.prepare('SELECT title, state_id FROM issue WHERE id = ?').get(issueId);
			expect(row).toEqual({ title: 'Owner work', state_id: OPEN });
			expect(eventCount(t, issueId)).toBe(events);
		});
	}

	for (const [name, revoke] of Object.entries(MEMBER_REVOCATIONS)) {
		it(`refuses a member run's comment after: ${name}`, async () => {
			const { t, issueId, runId, keyId } = await setup();
			const actor = await authenticate(t);
			revoke(t, { runId, keyId, issueId });
			const events = eventCount(t, issueId);
			expect(await bound(t, actor)).toBe(false);
			await expect(
				createComment(t.db, t.env, actor, issueId, { body: 'late' })
			).rejects.toMatchObject({ status: expect.any(Number) });
			expect(
				t.sqlite.prepare('SELECT count(*) AS n FROM comment WHERE issue_id = ?').get(issueId)
			).toEqual({ n: 0 });
			expect(eventCount(t, issueId)).toBe(events);
			expect((await getIssueDetail(t.db, USER, { id: issueId })).state.id).toBe(OPEN);
		});
	}
});

async function readJournal(t: TestDb, issueId: string): Promise<Response> {
	const url = new URL(`http://test/api/v1/issues/${issueId}/journal`);
	return getJournal({
		locals: {},
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url, { headers: { authorization: `Bearer ${BEARER}` } }),
		params: { id: issueId },
		url
	} as unknown as Parameters<typeof getJournal>[0]);
}

describe('GET /issues/:id/journal resolves the anchor before authorizing', () => {
	it('lets an owner run read its bound journal', async () => {
		const t = createTestDb();
		seedBase(t);
		const issueId = addIssue(t, { state: OPEN, title: 'Owner work' });
		const runId = addRun(t, { issueId, runnerId: addRunner(t), status: 'running' });
		const keyId = addRunKey(t, runId);
		t.sqlite.prepare('UPDATE api_key SET key_hash = ?, permissions = ? WHERE id = ?').run(
			await sha256Hex(BEARER),
			JSON.stringify({
				version: 1,
				projects: { access: 'write', scope: 'all' },
				workspace: 'write',
				control_plane: 'read'
			}),
			keyId
		);
		const res = await readJournal(t, issueId);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ anchor: 'run' });
	});

	it('lets a member run read its bound journal in the owner’s project', async () => {
		const { t, issueId } = await setup();
		const res = await readJournal(t, issueId);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ anchor: 'run', note: null });
	});

	it('refuses a journal the run is not anchored to', async () => {
		const { t } = await setup();
		const sibling = addIssue(t, { state: OPEN, title: 'Someone else’s issue' });
		const res = await readJournal(t, sibling);
		expect(res.status).toBe(403);
		expect(JSON.stringify(await res.json())).toContain('journal_anchor_unavailable');
	});
});

function writeSnapshot(t: TestDb) {
	const count = (table: string) =>
		(t.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
	return {
		events: count('event'),
		items: count('context_item'),
		versions: count('artifact_version'),
		labels: count('issue_label'),
		links: count('issue_link'),
		bodies: t.sqlite.prepare('SELECT id, body, version FROM context_item ORDER BY id').all()
	};
}

describe('standalone run writes re-check the binding at commit', () => {
	// Transfer is refused at preflight (outside_run_project); the rest pass
	// preflight on the stale actor and must be refused by the commit guard.
	const commitRevocations = Object.entries(OWNER_REVOCATIONS).filter(
		([name]) => name !== 'transferred'
	);
	for (const [name, revoke] of commitRevocations) {
		it(`refuses artifact, label, link and context writes after: ${name}`, async () => {
			const { t, issueId, runId, keyId } = await ownerRunSetup();
			const other = addIssue(t, { state: OPEN, title: 'Other' });
			const labelId = addLabel(t, 'bug');
			addLabel(t, 'chore');
			const fx = TEST_NOOP_DISPATCH_EFFECTS;
			// Deletes need project `delete` in the key's stored policy.
			t.sqlite
				.prepare(
					"UPDATE api_key SET permissions = json_set(permissions, '$.projects.access', 'delete')"
				)
				.run();
			const actor = await authenticate(t);
			// Seed with the live actor so every update/delete target exists.
			await upsertArtifact(t.db, t.env, actor, issueId, 'report', {
				type: 'text',
				content: '<html></html>'
			});
			t.sqlite.prepare("UPDATE artifact_version SET content_type = 'text/html'").run();
			await addIssueLabels(t.db, t.env, actor, fx, issueId, [labelId]);
			const link = await addIssueLink(t.db, t.env, actor, fx, issueId, {
				kind: 'blocks',
				issue_id: other
			});
			const notes = await createContextItem(t.db, t.env, actor, {
				kind: 'prompt',
				name: 'notes',
				body: 'first',
				issue_id: issueId
			});

			revoke(t, { runId, keyId, issueId });
			expect(await bound(t, actor)).toBe(false);
			const before = writeSnapshot(t);
			const inactive = { status: 401, code: 'run_key_inactive' };
			const writes: Record<string, () => Promise<unknown>> = {
				'artifact create': () =>
					upsertArtifact(t.db, t.env, actor, issueId, 'late', { type: 'text', content: 'x' }),
				'artifact version': () =>
					upsertArtifact(t.db, t.env, actor, issueId, 'report', { content: 'v2' }),
				'artifact description': () =>
					upsertArtifact(t.db, t.env, actor, issueId, 'report', { description: 'late' }),
				'artifact reaffirm': () => reaffirmArtifact(t.db, t.env, actor, issueId, 'report'),
				'artifact delete': () => deleteArtifact(t.db, t.env, actor, issueId, 'report'),
				'artifact site link': () =>
					createSiteLink(t.db, t.env, actor, issueId, 'report', {
						requestOrigin: 'http://test'
					}),
				'label assign': () => addIssueLabels(t.db, t.env, actor, fx, issueId, ['chore']),
				'label remove': () => removeIssueLabel(t.db, t.env, actor, fx, issueId, labelId),
				'link create': () =>
					addIssueLink(t.db, t.env, actor, fx, issueId, { kind: 'duplicate_of', issue_id: other }),
				'link remove': () => removeIssueLink(t.db, t.env, actor, fx, issueId, link.id),
				'context create': () =>
					createContextItem(t.db, t.env, actor, {
						kind: 'prompt',
						name: 'late',
						body: 'x',
						issue_id: issueId
					}),
				'context update': () =>
					updateContextItem(t.db, t.env, actor, notes.id, { body: 'rewritten' }),
				'context append': () => appendContextItem(t.db, t.env, actor, notes.id, { text: 'more' }),
				'context delete': () => deleteContextItem(t.db, t.env, actor, notes.id)
			};
			for (const [op, write] of Object.entries(writes)) {
				await expect(write(), op).rejects.toMatchObject(inactive);
			}
			expect(writeSnapshot(t)).toEqual(before);
		});
	}
});

async function sharedOwnerRunSetup(shared: boolean) {
	const setup = await ownerRunSetup();
	if (shared) {
		setup.t.sqlite.prepare('UPDATE project SET shared_at = ? WHERE id = ?').run(NOW, PROJECT);
	}
	return setup;
}

function ownerOffRows(t: TestDb, issueId: string) {
	return t.sqlite
		.prepare(
			`SELECT c.user_id, c.value, c.issue_epoch = i.consent_epoch AS current_epoch
			FROM issue_personal_choice c JOIN issue i ON i.id = c.issue_id WHERE c.issue_id = ?`
		)
		.all(issueId);
}

async function ownerWouldRun(t: TestDb, issueId: string): Promise<boolean> {
	const row = await t.db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.select(sql<number>`${ownerIssueConsentPredicate(USER)}`.as('ok'))
		.where('issue.id', '=', issueId)
		.executeTakeFirstOrThrow();
	return Boolean(row.ok);
}

describe('run-filed issues in shared projects are unapproved proposals', () => {
	it('creates an owner run’s issue with the owner’s agents off', async () => {
		const { t, runId } = await sharedOwnerRunSetup(true);
		const actor = await authenticate(t);
		const filed = await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'Follow-up'
		});
		expect(ownerOffRows(t, filed.id)).toEqual([{ user_id: USER, value: 'off', current_epoch: 1 }]);
		expect(await ownerWouldRun(t, filed.id)).toBe(false);
		expect(filed.permission_receipt).toMatchObject({
			actor: 'key',
			message: expect.stringContaining('Agents stay off until a person allows them.')
		});
		expect(
			t.sqlite.prepare('SELECT created_by_run_id FROM issue WHERE id = ?').get(filed.id)
		).toEqual({ created_by_run_id: runId });
	});

	it('creates a member run’s issue, and a link-created child, with the owner’s agents off', async () => {
		const { t, issueId } = await setup();
		const actor = await actorForProject(t.db, await authenticate(t), PROJECT);
		const filed = await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'Member follow-up'
		});
		const child = await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'Blocked child',
			blocked_by: [issueId]
		});
		for (const id of [filed.id, child.id]) {
			expect(ownerOffRows(t, id)).toEqual([{ user_id: USER, value: 'off', current_epoch: 1 }]);
			expect(await ownerWouldRun(t, id)).toBe(false);
		}
		// The parent's consent never propagates to the child.
		expect(ownerOffRows(t, issueId)).toEqual([]);
	});

	it('refuses a run key that tries to set consent on create', async () => {
		const { t } = await sharedOwnerRunSetup(true);
		const actor = await authenticate(t);
		await expect(
			createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
				title: 'Self-approved',
				allow_my_agents: true
			})
		).rejects.toMatchObject({ code: 'consent_browser_required' });
	});

	it('leaves a never-shared project unchanged', async () => {
		const { t } = await sharedOwnerRunSetup(false);
		const actor = await authenticate(t);
		const filed = await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'Private follow-up'
		});
		expect(ownerOffRows(t, filed.id)).toEqual([]);
		expect(await ownerWouldRun(t, filed.id)).toBe(true);
		expect(filed.permission_receipt).toBeUndefined();
	});
});

describe('a member run’s lifecycle events land once, in the owner’s stream', () => {
	it('writes one owner-stream row credited to the member, with private fields hidden', async () => {
		const { t, issueId, memberId, runId } = await setup();
		const payload = {
			run_id: runId,
			status: 'completed',
			outcome: 'success',
			usage: { cost_usd: 1.25 },
			error: 'secret failure',
			provider_session_url: 'https://provider.example/session'
		};
		const q = supervisorEvent(t.db, memberId, { type: 'agent_run.ended', issueId, payload }, NOW);
		t.sqlite.prepare(q.sql).run(...(q.parameters as never[]));
		const health = supervisorEvent(
			t.db,
			memberId,
			{ type: 'runner.errored', issueId, payload: { error: 'secret' } },
			NOW
		);
		t.sqlite.prepare(health.sql).run(...(health.parameters as never[]));
		expect(
			t.sqlite
				.prepare('SELECT user_id, actor_user_id, type FROM event WHERE issue_id = ? ORDER BY type')
				.all(issueId)
		).toEqual([
			{ user_id: USER, actor_user_id: memberId, type: 'agent_run.ended' },
			{ user_id: memberId, actor_user_id: memberId, type: 'runner.errored' }
		]);
		const [owner] = (
			await eventQuery(t.db, USER).where('event.issue_id', '=', issueId).execute()
		).map(serializeEvent);
		expect(owner.actor).toMatchObject({ user_id: memberId, user_name: 'bob' });
		expect(owner.payload).toEqual({ status: 'completed', outcome: 'success' });
		// The contributor's own view of its runner health keeps the full payload.
		const [mine] = (
			await eventQuery(t.db, memberId).where('event.issue_id', '=', issueId).execute()
		).map(serializeEvent);
		expect(mine.payload).toEqual({ error: 'secret' });
	});

	it('leaves an owner run’s events unchanged', async () => {
		const { t, issueId, runId } = await ownerRunSetup();
		const payload = { run_id: runId, status: 'completed', usage: { cost_usd: 1 } };
		const q = supervisorEvent(t.db, USER, { type: 'agent_run.ended', issueId, payload }, NOW);
		t.sqlite.prepare(q.sql).run(...(q.parameters as never[]));
		const rows = (await eventQuery(t.db, USER).where('event.issue_id', '=', issueId).execute()).map(
			serializeEvent
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).toEqual(payload);
	});
});
