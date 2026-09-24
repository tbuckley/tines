import { describe, expect, it } from 'vitest';
import { NOW, PROJECT, USER, addIssue, seedBase } from '../supervisor/test-fixtures';
import { createTestDb } from './test-db';
import { TEST_NOOP_DISPATCH_EFFECTS } from './test-dispatch-effects';
import { createIssue, updateIssue } from './issues';
import { addIssueLink } from './issue-links';
import { actorForIssue, actorForProject } from './project-access';
import { memberScopeAllowed, redactForMember, scopeIssueLinksForMember } from './member-context';
import type { ContextItem } from '@tines/shared';

function setup() {
	const t = createTestDb();
	seedBase(t);
	t.sqlite.exec(`
		INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt)
		VALUES ('u2','Bob','bob@example.com',1,${NOW},${NOW}),
		('u3','Eve','eve@example.com',1,${NOW},${NOW});
		UPDATE project SET shared_at = ${NOW}, sharing_revision = 1 WHERE id = '${PROJECT}';
		INSERT INTO project_member (project_id,user_id,revision,joined_at,updated_at)
		VALUES ('${PROJECT}','u2',1,${NOW},${NOW});
		INSERT INTO project (id, user_id, name, created_at, updated_at)
		VALUES ('prj_private', '${USER}', 'private', ${NOW}, ${NOW});
	`);
	const session = (userId: string, userName: string) => ({
		userId,
		userName,
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	});
	return {
		t,
		owner: session(USER, 'alice'),
		member: session('u2', 'Bob'),
		outsider: session('u3', 'Eve')
	};
}

describe('members work on a shared project with the owner scope', () => {
	it('delegates only current members, and leaves owners and outsiders as they are', async () => {
		const { t, owner, member, outsider } = setup();
		expect(await actorForProject(t.db, owner, PROJECT)).toBe(owner);
		const delegated = await actorForProject(t.db, member, PROJECT);
		expect(delegated).toMatchObject({
			userId: USER,
			userName: 'alice',
			member: { userId: 'u2', userName: 'Bob', projectId: PROJECT, membershipRevision: 1 }
		});
		await expect(actorForProject(t.db, outsider, PROJECT)).rejects.toMatchObject({ status: 404 });
		// The owner's unshared projects are never reachable through membership.
		await expect(actorForProject(t.db, member, 'prj_private')).rejects.toMatchObject({
			status: 404
		});
	});

	it('creates an issue attributed to the member, with the owner agents explicitly off', async () => {
		const { t, member } = setup();
		const actor = await actorForProject(t.db, member, PROJECT);
		const created = await createIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'Filed by a member'
		});
		expect(created.permission_receipt).toMatchObject({
			actor: 'member',
			my_agents: { value: 'on' }
		});
		const event = t.sqlite
			.prepare(`SELECT user_id, actor_user_id FROM event WHERE issue_id = ? AND type = ?`)
			.get(created.id, 'issue.created');
		expect(event).toEqual({ user_id: USER, actor_user_id: 'u2' });
		const choices = t.sqlite
			.prepare(
				`SELECT user_id, value, membership_revision FROM issue_personal_choice
				WHERE issue_id = ? ORDER BY user_id`
			)
			.all(created.id);
		expect(choices).toEqual([
			{ user_id: USER, value: 'off', membership_revision: 0 },
			{ user_id: 'u2', value: 'on', membership_revision: 1 }
		]);
	});

	it('links only within the shared project and hides the owner private links on reads', async () => {
		const { t, owner, member } = setup();
		const shared = addIssue(t, {});
		const sibling = addIssue(t, {});
		const hidden = addIssue(t, { project: 'prj_private', title: 'PRIVATE_CANARY' });
		const actor = await actorForIssue(t.db, member, shared);
		await expect(
			addIssueLink(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, shared, {
				kind: 'blocked_by',
				issue_id: hidden
			})
		).rejects.toMatchObject({ status: 404 });
		await addIssueLink(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, shared, {
			kind: 'blocks',
			issue_id: sibling
		});
		// The owner may still link across their own projects.
		await addIssueLink(t.db, t.env, owner, TEST_NOOP_DISPATCH_EFFECTS, shared, {
			kind: 'blocked_by',
			issue_id: hidden
		});
		const updated = await updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, shared, {
			title: 'Retitled by a member'
		});
		expect(JSON.stringify(updated)).toContain('PRIVATE_CANARY');
		const scoped = await scopeIssueLinksForMember(t.db, actor, updated);
		expect(JSON.stringify(scoped)).not.toContain('PRIVATE_CANARY');
		expect(scoped.links.blocks.map((end) => end.issue_id)).toEqual([sibling]);
		expect(scoped.blocked_by_private_issue).toBe(true);
	});

	it('keeps runner pins the owner, and refuses a member removed mid-request', async () => {
		const { t, member } = setup();
		const issue = addIssue(t, {});
		const actor = await actorForIssue(t.db, member, issue);
		await expect(
			updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, issue, {
				pinned_runner_id: 'rnr_x'
			})
		).rejects.toMatchObject({ status: 403, code: 'owner_only' });
		t.sqlite
			.prepare(`UPDATE project_member SET revoked_at = ?, revision = 2 WHERE user_id = ?`)
			.run(NOW + 1, 'u2');
		await expect(
			updateIssue(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, issue, { title: 'late' })
		).rejects.toMatchObject({ status: 404 });
		expect(t.sqlite.prepare(`SELECT title FROM issue WHERE id = ?`).get(issue)).not.toMatchObject({
			title: 'late'
		});
	});

	it('scopes context to the shared project and never returns an env value to a member', async () => {
		const { t, member } = setup();
		const actor = await actorForProject(t.db, member, PROJECT);
		const issue = addIssue(t, {});
		const hidden = addIssue(t, { project: 'prj_private' });
		expect(await memberScopeAllowed(t.db, actor, { project_id: PROJECT, issue_id: null })).toBe(
			true
		);
		expect(await memberScopeAllowed(t.db, actor, { project_id: null, issue_id: issue })).toBe(true);
		expect(await memberScopeAllowed(t.db, actor, { project_id: null, issue_id: null })).toBe(false);
		expect(await memberScopeAllowed(t.db, actor, { project_id: null, issue_id: hidden })).toBe(
			false
		);
		const env = { kind: 'env', value: 'TOKEN_CANARY', secret: false } as ContextItem;
		expect(redactForMember(actor, env)).toEqual({ kind: 'env', secret: false, value_set: true });
		expect(redactForMember(member, env)).toBe(env);
	});
});
