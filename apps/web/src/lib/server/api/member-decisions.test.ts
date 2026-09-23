import { describe, expect, it } from 'vitest';
import { FULL_API_KEY_PERMISSIONS } from '@tines/shared';
import { NOW, PROJECT, REVIEW, OPEN, USER, addIssue, seedBase } from '../supervisor/test-fixtures';
import { createTestDb } from './test-db';
import { TEST_NOOP_DISPATCH_EFFECTS } from './test-dispatch-effects';
import { createComment, updateComment, deleteComment, transitionIssue } from './issues';
import { readIssueConsent, writeIssueConsent } from './personal-consent';
import { listSharedEvents } from './shared-events';
import { eventQuery } from './events';
import { readSharedIssue } from './shared-issues';

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
	`);
	const issueId = addIssue(t, { state: REVIEW });
	const owner = {
		userId: USER,
		userName: 'alice',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};
	const member = {
		userId: 'u2',
		userName: 'Bob',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};
	const outsider = {
		userId: 'u3',
		userName: 'Eve',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};
	return { t, issueId, owner, member, outsider };
}

describe('attributed member decisions', () => {
	it('keeps member issue reads and writes scoped to a current human or named key', async () => {
		const { t, issueId, owner, member, outsider } = setup();
		const namedKey = {
			...member,
			apiKeyId: 'key_bob',
			apiKeyName: 'Bob key',
			viaSession: false,
			bearerPresent: true,
			permissions: FULL_API_KEY_PERMISSIONS
		};
		const runKey = { ...namedKey, agentRunId: 'arun_bob' };
		t.sqlite.exec(`INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt)
			VALUES ('u4','Pending','pending@example.com',1,${NOW},${NOW});
			INSERT INTO api_key (id,user_id,name,key_hash,key_prefix,created_at)
			VALUES ('key_bob','u2','Bob key','key_bob_hash','key_bob',${NOW});
			INSERT INTO project_invitation (id,project_id,email,token_hash,expires_at,created_by_user_id,created_at,updated_at)
			VALUES ('inv_pending','${PROJECT}','pending@example.com','pending_hash',${NOW + 100000},'${USER}',${NOW},${NOW});`);
		const pending = { ...member, userId: 'u4', userName: 'Pending' };
		for (const actor of [member, namedKey]) {
			const view = await readSharedIssue(t.db, actor, { id: issueId });
			expect(view.project.owner.id).toBe(owner.userId);
			expect(view.capabilities.execute).toBe(false);
		}
		await expect(readSharedIssue(t.db, runKey, { id: issueId })).rejects.toMatchObject({
			status: 404
		});
		for (const actor of [pending, outsider]) {
			await expect(readSharedIssue(t.db, actor, { id: issueId })).rejects.toMatchObject({
				status: 404
			});
			await expect(
				createComment(t.db, t.env, actor, issueId, { body: 'hidden' })
			).rejects.toMatchObject({
				status: 404
			});
		}
		const fromKey = await createComment(t.db, t.env, namedKey, issueId, { body: 'named' });
		expect(fromKey.actor).toMatchObject({ user_id: member.userId, api_key_id: 'key_bob' });
		await expect(
			writeIssueConsent(t.db, t.env, namedKey, issueId, {
				value: 'off',
				expected_revision: 0,
				issue_epoch: 0,
				decision_revision: 0
			})
		).rejects.toMatchObject({ status: 403 });
		expect(t.all('SELECT * FROM issue_personal_choice WHERE issue_id = ?', issueId)).toEqual([]);
	});

	it('intersects membership writes with the named key project scope', async () => {
		const { t, issueId, member } = setup();
		const readKey = {
			...member,
			viaSession: false,
			apiKeyId: 'key_read',
			permissions: {
				...FULL_API_KEY_PERMISSIONS,
				projects: { access: 'read' as const, scope: [PROJECT] }
			}
		};
		const writeKey = {
			...readKey,
			apiKeyId: 'key_write',
			permissions: {
				...readKey.permissions,
				projects: { access: 'write' as const, scope: [PROJECT] }
			}
		};
		const foreignKey = {
			...writeKey,
			permissions: {
				...writeKey.permissions,
				projects: { access: 'write' as const, scope: ['prj_elsewhere'] }
			}
		};
		t.sqlite
			.prepare(
				'INSERT INTO api_key (id,user_id,name,key_hash,key_prefix,created_at) VALUES (?,?,?,?,?,?)'
			)
			.run('key_write', member.userId, 'Write key', 'write_hash', 'write', NOW);
		expect((await readSharedIssue(t.db, readKey, { id: issueId })).id).toBe(issueId);
		await expect(
			createComment(t.db, t.env, readKey, issueId, { body: 'denied' })
		).rejects.toMatchObject({
			code: 'insufficient_permissions'
		});
		await expect(readSharedIssue(t.db, foreignKey, { id: issueId })).rejects.toMatchObject({
			code: 'insufficient_permissions'
		});
		await createComment(t.db, t.env, writeKey, issueId, { body: 'allowed' });
		expect(t.all('SELECT body FROM comment WHERE issue_id = ?', issueId)).toContainEqual({
			body: 'allowed'
		});
	});

	it('keeps one event in the owner and member feeds, and attributes comment repair', async () => {
		const { t, issueId, owner, member } = setup();
		const created = await createComment(t.db, t.env, member, issueId, { body: 'first' });
		const edited = await updateComment(t.db, t.env, member, issueId, created.id, { body: 'fixed' });
		expect(edited.actor.user_id).toBe('u2');
		expect(edited.editor?.user_id).toBe('u2');
		const ownerEvent = await eventQuery(t.db, USER).where('event.issue_id', '=', issueId).execute();
		const memberEvent = await listSharedEvents(t.db, member, { issueId, limit: 20 });
		expect(ownerEvent.map((e) => e.id)).toEqual(
			expect.arrayContaining(memberEvent.items.map((e) => e.id))
		);
		expect(new Set(ownerEvent.map((e) => e.id)).size).toBe(ownerEvent.length);
		await expect(
			updateComment(t.db, t.env, owner, issueId, created.id, { body: 'owner repair' })
		).resolves.toMatchObject({ body: 'owner repair' });
		await deleteComment(t.db, t.env, member, issueId, created.id);
	});

	it('refuses foreign repair and removed access, including a stale choice', async () => {
		const { t, issueId, owner, member, outsider } = setup();
		const byOwner = await createComment(t.db, t.env, owner, issueId, { body: 'owner' });
		await expect(
			updateComment(t.db, t.env, member, issueId, byOwner.id, { body: 'foreign' })
		).rejects.toMatchObject({ status: 403 });
		await expect(
			createComment(t.db, t.env, outsider, issueId, { body: 'outsider' })
		).rejects.toMatchObject({ status: 404 });
		const on = await writeIssueConsent(t.db, t.env, member, issueId, {
			value: 'on',
			expected_revision: 0,
			issue_epoch: 0,
			decision_revision: 0
		});
		expect(on).toMatchObject({ actor: 'member', readiness: 'unavailable', admitted_run: null });
		t.sqlite
			.prepare(
				`UPDATE project_member SET revoked_at = ?, revision = 2 WHERE project_id = ? AND user_id = ?`
			)
			.run(NOW + 1, PROJECT, 'u2');
		await expect(
			writeIssueConsent(t.db, t.env, member, issueId, {
				value: 'off',
				expected_revision: 1,
				issue_epoch: 0,
				decision_revision: 0
			})
		).rejects.toMatchObject({ status: 404 });
		await expect(
			createComment(t.db, t.env, member, issueId, { body: 'removed' })
		).rejects.toMatchObject({ status: 404 });
	});

	it('accepts only an exact awaiting-human decision and never admits member execution', async () => {
		const { t, issueId, member } = setup();
		const before = await (
			await import('./shared-issues')
		).readSharedIssue(t.db, member, { id: issueId });
		const target = before.workflow.transitions.find((x) => x.to_state_id === OPEN);
		expect(target).toBeDefined();
		await expect(
			transitionIssue(t.db, t.env, member, TEST_NOOP_DISPATCH_EFFECTS, issueId, {
				transition_id: target!.id,
				expected_state_id: before.state.id,
				expected_decision_revision: before.decision_revision,
				expected_consent_revision: before.my_choice.revision,
				expected_consent_epoch: before.my_choice.epoch,
				expected_workflow_revision: before.workflow_revision
			})
		).resolves.toMatchObject({ state: { id: OPEN }, capabilities: { execute: false } });
		const choice = await readIssueConsent(t.db, member.userId, issueId);
		expect(choice).toMatchObject({ actor: 'member', readiness: 'unavailable', admitted_run: null });
		await expect(
			transitionIssue(t.db, t.env, member, TEST_NOOP_DISPATCH_EFFECTS, issueId, {
				transition_id: target!.id,
				expected_state_id: before.state.id,
				expected_decision_revision: before.decision_revision,
				expected_consent_revision: before.my_choice.revision,
				expected_consent_epoch: before.my_choice.epoch,
				expected_workflow_revision: before.workflow_revision
			})
		).rejects.toMatchObject({ status: 403 });
	});
});
