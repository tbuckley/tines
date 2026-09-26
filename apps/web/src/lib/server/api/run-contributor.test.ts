import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { createTestDb, type TestDb } from './test-db';
import { requireActor, sha256Hex, type ActorContext } from './core';
import { loadIssueForActor } from './issues';
import {
	actorForIssue,
	actorForProject,
	assertNotMember,
	resolveProjectAccess,
	runProjectActor
} from './project-access';
import {
	NOW,
	OPEN,
	PROJECT,
	USER,
	addIssue,
	addMemberContributorRun,
	addRun,
	addRunKey,
	addRunner,
	seedBase
} from '../supervisor/test-fixtures';

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
