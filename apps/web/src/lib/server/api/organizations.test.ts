import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { FULL_API_KEY_PERMISSIONS } from '@tines/shared';
import { createTestDb } from './test-db';
import { requireActor, sessionActor, sha256Hex, type ActorContext } from './core';
import { createContextItem, effectiveContextForIssue } from './context';
import { createIssue } from './issues';
import { createProject, getProject, listProjects } from './projects';
import { createWorkflow } from './workflows';
import { resolveProjectAccess } from './project-access';
import { addIssueLabels } from './labels';
import {
	acceptOrganizationInvitation,
	createOrganization,
	deleteOrganization,
	getOrganization,
	inviteToOrganization,
	listOrganizations,
	removeOrganizationMember,
	transferOrganization
} from './organizations';
import { moveProject, previewProjectMove, shareProject } from './org-move';

const NOW = Date.now();
const effects = { signalDispatch: () => {} } as never;

function fixture() {
	const t = createTestDb();
	for (const [id, email] of [
		['owner', 'owner@example.com'],
		['bob', 'bob@example.com'],
		['carol', 'carol@example.com']
	])
		t.sqlite
			.prepare(
				'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)'
			)
			.run(id, id, email, 1, NOW, NOW);
	const owner = sessionActor({ id: 'owner', name: 'owner' });
	const bob = sessionActor({ id: 'bob', name: 'bob' });
	const env = t.env as Env;
	return { ...t, env, owner, bob };
}

/** Invites `who` by email and accepts with their session; returns nothing. */
async function join(
	t: ReturnType<typeof fixture>,
	orgId: string,
	actor: ActorContext,
	email: string
) {
	await inviteToOrganization(t.db, t.env, t.owner, orgId, { email }, 'http://test');
	// The token is only in the email: mint a known one for the test.
	const token = 'b'.repeat(63) + actor.userId.length;
	t.sqlite
		.prepare(
			'UPDATE organization_invitation SET token_hash = ? WHERE email = ? AND accepted_at IS NULL'
		)
		.run(await sha256Hex(token), email);
	await acceptOrganizationInvitation(t.db, t.env, actor, token);
}

async function keyActor(t: ReturnType<typeof fixture>, userId: string, permissions: unknown) {
	const bearer = `tines_${userId}${Math.random().toString(36).slice(2)}${'x'.repeat(20)}`;
	t.sqlite
		.prepare(
			`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, permissions, created_at)
			VALUES (?, ?, 'k', ?, 'tines_xx', ?, ?)`
		)
		.run(
			`key_${userId}_${Math.random()}`,
			userId,
			await sha256Hex(bearer),
			JSON.stringify(permissions),
			NOW
		);
	return requireActor({
		locals: {},
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request('http://test/api/v1/x', {
			headers: { authorization: `Bearer ${bearer}` }
		}),
		url: new URL('http://test/api/v1/x')
	} as unknown as RequestEvent);
}

describe('organizations', () => {
	it('gives everyone a personal organization and creates shared ones', async () => {
		const t = fixture();
		const before = await listOrganizations(t.db, t.owner);
		expect(before).toEqual([
			expect.objectContaining({ id: 'org_owner', kind: 'personal', role: 'owner' })
		]);
		const org = await createOrganization(t.db, t.env, t.owner, { name: 'Acme' });
		expect(org).toMatchObject({ kind: 'shared', role: 'owner', member_count: 1 });
		expect((await listOrganizations(t.db, t.owner)).map((o) => o.name)).toEqual(['owner', 'Acme']);
	});

	it('lists a personal organization that has no row yet without writing one', async () => {
		const t = fixture();
		await createProject(t.db, t.env, t.bob, { name: 'bobs' });
		// As for an account whose personal row was never written.
		t.sqlite.prepare("DELETE FROM organization_member WHERE organization_id = 'org_bob'").run();
		t.sqlite.prepare("DELETE FROM organization WHERE id = 'org_bob'").run();
		const [personal] = await listOrganizations(t.db, t.bob);
		expect(personal).toMatchObject({
			id: 'org_bob',
			kind: 'personal',
			role: 'owner',
			project_count: 1
		});
		const row = t.sqlite.prepare("SELECT id FROM organization WHERE id = 'org_bob'").get();
		expect(row).toBeUndefined();
	});

	it('keeps personal context out of a shared organization, and the organization’s out of personal projects', async () => {
		const t = fixture();
		const org = await createOrganization(t.db, t.env, t.owner, { name: 'Acme' });
		const personal = await createProject(t.db, t.env, t.owner, { name: 'mine' });
		const shared = await createProject(t.db, t.env, t.owner, {
			name: 'team',
			organization_id: org.id
		});
		expect(shared.organization).toMatchObject({ id: org.id, kind: 'shared' });
		await createContextItem(t.db, t.env, t.owner, {
			kind: 'prompt',
			name: 'personal-rules',
			body: 'P'
		});
		await createContextItem(t.db, t.env, t.owner, {
			kind: 'prompt',
			name: 'team-rules',
			body: 'T',
			organization_id: org.id
		});
		// The same name may exist in both organizations.
		await createContextItem(t.db, t.env, t.owner, {
			kind: 'prompt',
			name: 'personal-rules',
			body: 'T2',
			organization_id: org.id
		});
		const inShared = await createIssue(t.db, t.env, t.owner, effects, shared.id, {
			title: 'x'
		} as never);
		const inPersonal = await createIssue(t.db, t.env, t.owner, effects, personal.id, {
			title: 'y'
		} as never);
		const sharedCtx = await effectiveContextForIssue(t.db, 'owner', inShared.id);
		const personalCtx = await effectiveContextForIssue(t.db, 'owner', inPersonal.id);
		expect(sharedCtx.prompt.parts.map((p) => p.body).sort()).toEqual(['T', 'T2']);
		expect(personalCtx.prompt.parts.map((p) => p.body)).toEqual(['P']);
	});

	it('makes everyone in a shared organization a member of its projects, and removal ends it', async () => {
		const t = fixture();
		const org = await createOrganization(t.db, t.env, t.owner, { name: 'Acme' });
		const before = await createProject(t.db, t.env, t.owner, {
			name: 'early',
			organization_id: org.id
		});
		await join(t, org.id, t.bob, 'bob@example.com');
		const after = await createProject(t.db, t.env, t.owner, {
			name: 'late',
			organization_id: org.id
		});
		for (const p of [before, after]) {
			const access = await resolveProjectAccess(t.db, t.bob, p.id);
			expect(access.role).toBe('member');
		}
		const detail = await getOrganization(t.db, t.bob, org.id);
		expect(detail.members.map((m) => `${m.user_id}:${m.role}`)).toEqual([
			'owner:owner',
			'bob:manager'
		]);
		// A manager creates a project in the organization: the owner owns it, the manager is a member.
		const byBob = await createProject(t.db, t.env, t.bob, {
			name: 'bobs',
			organization_id: org.id
		});
		expect(t.sqlite.prepare('SELECT user_id FROM project WHERE id = ?').get(byBob.id)).toEqual({
			user_id: 'owner'
		});
		expect((await resolveProjectAccess(t.db, t.bob, byBob.id)).role).toBe('member');

		await removeOrganizationMember(t.db, t.env, t.owner, org.id, 'bob');
		await expect(resolveProjectAccess(t.db, t.bob, before.id)).rejects.toMatchObject({
			status: 404
		});
		await expect(
			removeOrganizationMember(t.db, t.env, t.owner, org.id, 'owner')
		).rejects.toMatchObject({
			code: 'owner_cannot_leave'
		});
	});

	it('refuses a workflow from another organization', async () => {
		const t = fixture();
		const org = await createOrganization(t.db, t.env, t.owner, { name: 'Acme' });
		const shared = await createProject(t.db, t.env, t.owner, {
			name: 'team',
			organization_id: org.id
		});
		const personalWf = await createWorkflow(t.db, t.env, t.owner, {
			name: 'Mine',
			initial_state: 'Todo',
			states: [
				{ name: 'Todo', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [{ name: 'Finish', from: 'Todo', to: 'Done' }]
		});
		await expect(
			createIssue(t.db, t.env, t.owner, effects, shared.id, {
				title: 'x',
				workflow_id: personalWf.id
			} as never)
		).rejects.toMatchObject({ code: 'workflow_not_in_organization' });
		const orgWf = await createWorkflow(t.db, t.env, t.owner, {
			name: 'Team',
			organization_id: org.id,
			initial_state: 'Todo',
			states: [{ name: 'Todo', category: 'active' }],
			transitions: []
		});
		expect(orgWf.organization_id).toBe(org.id);
		await expect(
			createIssue(t.db, t.env, t.owner, effects, shared.id, {
				title: 'x',
				workflow_id: orgWf.id
			} as never)
		).resolves.toBeTruthy();
	});

	it('resolves labels within the issue’s organization', async () => {
		const t = fixture();
		const org = await createOrganization(t.db, t.env, t.owner, { name: 'Acme' });
		const personal = await createProject(t.db, t.env, t.owner, { name: 'mine' });
		const shared = await createProject(t.db, t.env, t.owner, {
			name: 'team',
			organization_id: org.id
		});
		const a = await createIssue(t.db, t.env, t.owner, effects, personal.id, {
			title: 'a',
			labels: ['bug']
		} as never);
		const b = await createIssue(t.db, t.env, t.owner, effects, shared.id, { title: 'b' } as never);
		await addIssueLabels(t.db, t.env, t.owner, effects, b.id, ['bug']);
		const rows = t.sqlite
			.prepare(
				`SELECT il.issue_id, COALESCE(l.organization_id, 'org_' || l.user_id) AS org FROM issue_label il JOIN label l ON l.id = il.label_id ORDER BY il.issue_id`
			)
			.all() as { issue_id: string; org: string }[];
		expect(Object.fromEntries(rows.map((r) => [r.issue_id, r.org]))).toEqual({
			[a.id]: 'org_owner',
			[b.id]: org.id
		});
	});

	it('transfers ownership: the organization’s rows follow, the old owner becomes a member', async () => {
		const t = fixture();
		const org = await createOrganization(t.db, t.env, t.owner, { name: 'Acme' });
		const p = await createProject(t.db, t.env, t.owner, { name: 'team', organization_id: org.id });
		await createContextItem(t.db, t.env, t.owner, {
			kind: 'prompt',
			name: 'org-rules',
			body: 'x',
			organization_id: org.id
		});
		await join(t, org.id, t.bob, 'bob@example.com');
		await transferOrganization(t.db, t.env, t.owner, org.id, { to_user_id: 'bob' });
		expect(t.sqlite.prepare('SELECT user_id FROM project WHERE id = ?').get(p.id)).toEqual({
			user_id: 'bob'
		});
		expect(
			t.sqlite.prepare("SELECT user_id FROM context_item WHERE name = 'org-rules'").get()
		).toEqual({ user_id: 'bob' });
		expect((await resolveProjectAccess(t.db, t.owner, p.id)).role).toBe('member');
		expect((await resolveProjectAccess(t.db, t.bob, p.id)).role).toBe('owner');
		const detail = await getOrganization(t.db, t.bob, org.id);
		expect(detail.owner.id).toBe('bob');
		// The previous owner may now leave.
		await removeOrganizationMember(t.db, t.env, t.owner, org.id, 'owner');
	});

	it('shares a personal project: workflows come as copies, issues follow, the owner’s keys gain the organization', async () => {
		const t = fixture();
		const wf = await createWorkflow(t.db, t.env, t.owner, {
			name: 'Mine',
			initial_state: 'Todo',
			states: [
				{ name: 'Todo', category: 'active', prompt: 'Do it carefully.' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [{ name: 'Finish', from: 'Todo', to: 'Done' }]
		});
		const p = await createProject(t.db, t.env, t.owner, {
			name: 'app',
			default_workflow_id: wf.id
		});
		const issue = await createIssue(t.db, t.env, t.owner, effects, p.id, {
			title: 'x',
			labels: ['bug']
		} as never);
		await createContextItem(t.db, t.env, t.owner, { kind: 'prompt', name: 'global', body: 'G' });
		const v1 = { ...FULL_API_KEY_PERMISSIONS };
		t.sqlite
			.prepare(
				`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, permissions, created_at)
				VALUES ('key_owner_v1', 'owner', 'cli', 'h', 'tines_xx', ?, ?)`
			)
			.run(JSON.stringify(v1), NOW);

		const shared = await shareProject(t.db, t.env, t.owner, p.id, { bring_context: true });
		const moved = await getProject(t.db, t.owner, p.id);
		expect(moved.organization).toMatchObject({ id: shared.organization_id, kind: 'shared' });
		const issueRow = t.sqlite
			.prepare('SELECT workflow_id FROM issue WHERE id = ?')
			.get(issue.id) as { workflow_id: string };
		expect(issueRow.workflow_id).not.toBe(wf.id);
		const copy = t.sqlite
			.prepare('SELECT name, organization_id FROM workflow WHERE id = ?')
			.get(issueRow.workflow_id);
		expect(copy).toEqual({ name: 'Mine', organization_id: shared.organization_id });
		const ctx = await effectiveContextForIssue(t.db, 'owner', issue.id);
		expect(ctx.prompt.parts.map((part) => part.body)).toEqual(['G', 'Do it carefully.']);
		const key = t.sqlite
			.prepare("SELECT permissions FROM api_key WHERE id = 'key_owner_v1'")
			.get() as {
			permissions: string;
		};
		expect(JSON.parse(key.permissions).organizations).toEqual(
			['org_owner', shared.organization_id].sort()
		);
		const label = t.sqlite
			.prepare(
				`SELECT COALESCE(l.organization_id, 'org_' || l.user_id) AS org FROM issue_label il JOIN label l ON l.id = il.label_id WHERE il.issue_id = ?`
			)
			.get(issue.id);
		expect(label).toEqual({ org: shared.organization_id });
	});

	it('moves a project to an organization with other people, who gain access', async () => {
		const t = fixture();
		const org = await createOrganization(t.db, t.env, t.owner, { name: 'Acme' });
		await join(t, org.id, t.bob, 'bob@example.com');
		const p = await createProject(t.db, t.env, t.owner, { name: 'app' });
		const preview = await previewProjectMove(t.db, t.owner, p.id, org.id);
		expect(preview.people.gain.map((g) => g.id)).toEqual(['bob']);
		expect(preview.blockers).toEqual([]);
		await expect(
			moveProject(t.db, t.env, t.owner, p.id, {
				to_organization_id: org.id,
				expected_digest: 'stale'
			})
		).rejects.toMatchObject({ code: 'move_preview_stale' });
		await moveProject(t.db, t.env, t.owner, p.id, {
			to_organization_id: org.id,
			expected_digest: preview.digest
		});
		expect((await resolveProjectAccess(t.db, t.bob, p.id)).role).toBe('member');
		// And back: Bob loses access.
		const back = await previewProjectMove(t.db, t.owner, p.id, 'org_owner');
		expect(back.people.lose.map((g) => g.id)).toEqual(['bob']);
		await moveProject(t.db, t.env, t.owner, p.id, {
			to_organization_id: 'org_owner',
			expected_digest: back.digest
		});
		await expect(resolveProjectAccess(t.db, t.bob, p.id)).rejects.toMatchObject({ status: 404 });
	});

	it('keeps a key that does not name an organization out of it', async () => {
		const t = fixture();
		const org = await createOrganization(t.db, t.env, t.owner, { name: 'Acme' });
		const shared = await createProject(t.db, t.env, t.owner, {
			name: 'team',
			organization_id: org.id
		});
		const personal = await createProject(t.db, t.env, t.owner, { name: 'mine' });
		const v1 = await keyActor(t, 'owner', FULL_API_KEY_PERMISSIONS);
		expect((await listProjects(t.db, v1)).map((p) => p.name)).toEqual(['mine']);
		await expect(getProject(t.db, v1, shared.id)).rejects.toMatchObject({ status: 404 });
		await expect(getProject(t.db, v1, personal.id)).resolves.toBeTruthy();
		const v2 = await keyActor(t, 'owner', { ...FULL_API_KEY_PERMISSIONS, organizations: [org.id] });
		expect((await listProjects(t.db, v2)).map((p) => p.name)).toEqual(['team']);
		const all = await keyActor(t, 'owner', { ...FULL_API_KEY_PERMISSIONS, organizations: 'all' });
		expect((await listProjects(t.db, all)).map((p) => p.name).sort()).toEqual(['mine', 'team']);
	});

	it('deletes an organization whose projects are empty, and refuses one with issues', async () => {
		const t = fixture();
		const org = await createOrganization(t.db, t.env, t.owner, { name: 'Acme' });
		const p = await createProject(t.db, t.env, t.owner, { name: 'team', organization_id: org.id });
		await createIssue(t.db, t.env, t.owner, effects, p.id, { title: 'x' } as never);
		await expect(
			deleteOrganization(t.db, t.env, t.owner, org.id, { confirm_name: 'nope' })
		).rejects.toMatchObject({
			code: 'confirm_name'
		});
		await expect(
			deleteOrganization(t.db, t.env, t.owner, org.id, { confirm_name: 'Acme' })
		).rejects.toMatchObject({
			code: 'organization_not_empty'
		});
		const empty = await createOrganization(t.db, t.env, t.owner, { name: 'Empty' });
		await createProject(t.db, t.env, t.owner, { name: 'blank', organization_id: empty.id });
		await deleteOrganization(t.db, t.env, t.owner, empty.id, { confirm_name: 'Empty' });
		expect((await listOrganizations(t.db, t.owner)).map((o) => o.name)).toEqual(['owner', 'Acme']);
	});
});
