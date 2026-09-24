import { describe, expect, it } from 'vitest';
import { FULL_API_KEY_PERMISSIONS } from '@tines/shared';
import { createTestDb } from './test-db';
import type { ActorContext } from './core';
import {
	acceptInvitation,
	cancelInvitation,
	createInvitation,
	invitationLanding,
	listPeople,
	removeMember,
	resendInvitation
} from './invitations';
import { readSharedProject } from './shared-projects';
import { resolveProjectAccess } from './project-access';
import { resolveAccessibleProjectRef } from './project-access';
import { readSharedIssue } from './shared-issues';
import { createIssue } from './issues';
import { TEST_NOOP_DISPATCH_EFFECTS } from './test-dispatch-effects';

const owner: ActorContext = {
	userId: 'owner',
	userName: 'Owner',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};
const member: ActorContext = {
	userId: 'member',
	userName: 'Member',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};
const outsider: ActorContext = {
	userId: 'outsider',
	userName: 'Outsider',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};
function fixture() {
	const t = createTestDb();
	const now = Date.now();
	t.sqlite
		.prepare(
			'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)'
		)
		.run('owner', 'Owner', 'owner@test.invalid', 1, now, now);
	t.sqlite
		.prepare(
			'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)'
		)
		.run('member', 'Member', 'member@test.invalid', 1, now, now);
	t.sqlite
		.prepare(
			'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)'
		)
		.run('outsider', 'Outsider', 'outsider@test.invalid', 1, now, now);
	t.sqlite
		.prepare(
			'INSERT INTO project (id,user_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)'
		)
		.run('prj_shared', 'owner', 'A project', 'Visible summary', now, now);
	const emails: string[] = [];
	const env = {
		...t.env,
		EMAIL_FROM: 'invites@test.invalid',
		EMAIL: {
			send: async (message: { text: string }) => {
				emails.push(message.text);
			}
		}
	} as unknown as Env;
	const token = () => emails.at(-1)?.match(/\/invites\/([a-f0-9]{64})/)?.[1] ?? '';
	return { ...t, env, emails, token };
}

describe('invitations and membership', () => {
	it('requires project write authority before a scoped key begins first sharing', async () => {
		const t = fixture();
		const readKey: ActorContext = {
			...owner,
			viaSession: false,
			apiKeyId: 'key_read',
			permissions: {
				...FULL_API_KEY_PERMISSIONS,
				projects: { access: 'read', scope: ['prj_shared'] }
			}
		};
		await expect(
			createInvitation(
				t.db,
				t.env,
				readKey,
				'prj_shared',
				{ email: 'member@test.invalid', expected_sharing_revision: 0, confirm_sharing: true },
				'https://example.test'
			)
		).rejects.toMatchObject({ code: 'insufficient_permissions' });
		expect(t.all('SELECT id FROM project_invitation')).toEqual([]);
		expect(t.all('SELECT shared_at FROM project WHERE id = ?', 'prj_shared')).toEqual([
			{ shared_at: null }
		]);
	});

	it('requires explicit first sharing; saves one invited person without exposing a token in inventory', async () => {
		const t = fixture();
		await expect(
			createInvitation(
				t.db,
				t.env,
				owner,
				'prj_shared',
				{ email: ' MEMBER@test.invalid ', expected_sharing_revision: 0 },
				'https://example.test'
			)
		).rejects.toMatchObject({ code: 'confirm_sharing_required' });
		expect(t.all('SELECT id FROM project_invitation')).toEqual([]);
		const saved = await createInvitation(
			t.db,
			t.env,
			owner,
			'prj_shared',
			{ email: ' MEMBER@test.invalid ', expected_sharing_revision: 0, confirm_sharing: true },
			'https://example.test'
		);
		expect(saved).toMatchObject({ email: 'member@test.invalid', delivery_status: 'sent' });
		expect(t.all('SELECT shared_at,sharing_revision FROM project')).toMatchObject([
			{ shared_at: expect.any(Number), sharing_revision: 1 }
		]);
		expect(t.all('SELECT token_hash FROM project_invitation')[0]).not.toMatchObject({
			token_hash: t.token()
		});
		await expect(resolveProjectAccess(t.db, member, 'prj_shared')).rejects.toMatchObject({
			status: 404
		});
		expect(await invitationLanding(t.db, t.token(), 'outsider')).toMatchObject({
			matching_account: false,
			project: { name: 'A project' }
		});
		await expect(acceptInvitation(t.db, t.env, outsider, t.token())).rejects.toMatchObject({
			code: 'wrong_account'
		});
		const accepted = await acceptInvitation(t.db, t.env, member, t.token());
		expect(accepted).toMatchObject({
			project_id: 'prj_shared',
			membership_revision: 1,
			already_accepted: false
		});
		expect(await acceptInvitation(t.db, t.env, member, t.token())).toMatchObject({
			already_accepted: true
		});
		expect((await readSharedProject(t.db, member, 'prj_shared')).viewer_role).toBe('member');
		expect((await listPeople(t.db, member, 'prj_shared')).members).toMatchObject([
			{ id: 'member' }
		]);
	});

	it('rotates links, rejects canceled links and removal never reopens a consumed invitation', async () => {
		const t = fixture();
		const first = await createInvitation(
			t.db,
			t.env,
			owner,
			'prj_shared',
			{ email: 'member@test.invalid', expected_sharing_revision: 0, confirm_sharing: true },
			'https://example.test'
		);
		const oldToken = t.token();
		const next = await resendInvitation(
			t.db,
			t.env,
			owner,
			'prj_shared',
			first.id,
			1,
			'https://example.test'
		);
		expect(next.generation).toBe(2);
		await expect(acceptInvitation(t.db, t.env, member, oldToken)).rejects.toMatchObject({
			status: 404
		});
		const currentToken = t.token();
		await acceptInvitation(t.db, t.env, member, currentToken);
		await removeMember(t.db, t.env, owner, 'prj_shared', 'member', 1);
		await expect(resolveProjectAccess(t.db, member, 'prj_shared')).rejects.toMatchObject({
			status: 404
		});
		await expect(acceptInvitation(t.db, t.env, member, currentToken)).rejects.toMatchObject({
			status: 404
		});
		const reinvite = await createInvitation(
			t.db,
			t.env,
			owner,
			'prj_shared',
			{ email: 'member@test.invalid', expected_sharing_revision: 1 },
			'https://example.test'
		);
		expect(reinvite.generation).toBe(1);
		expect((await acceptInvitation(t.db, t.env, member, t.token())).membership_revision).toBe(3);
		await expect(
			removeMember(t.db, t.env, member, 'prj_shared', 'member', 1)
		).rejects.toMatchObject({ code: 'member_changed' });
	});

	it('cancel invalidates a pending token and a missing email binding marks delivery failed after commit', async () => {
		const t = fixture();
		const saved = await createInvitation(
			t.db,
			{ ...t.env, EMAIL: undefined },
			owner,
			'prj_shared',
			{ email: 'member@test.invalid', expected_sharing_revision: 0, confirm_sharing: true },
			'https://example.test'
		);
		expect(saved.delivery_status).toBe('failed');
		expect(t.all('SELECT id FROM project_invitation')).toHaveLength(1);
		await cancelInvitation(t.db, owner, 'prj_shared', saved.id, 1);
		await expect(
			resendInvitation(t.db, t.env, owner, 'prj_shared', saved.id, 1, 'https://example.test')
		).rejects.toMatchObject({ code: 'invite_inactive' });
	});

	it('member issue projection excludes private context and ambiguous names disclose accessible IDs only', async () => {
		const t = fixture();
		await createInvitation(
			t.db,
			t.env,
			owner,
			'prj_shared',
			{ email: 'member@test.invalid', expected_sharing_revision: 0, confirm_sharing: true },
			'https://example.test'
		);
		await acceptInvitation(t.db, t.env, member, t.token());
		const keyOwner = {
			...owner,
			viaSession: false,
			apiKeyId: 'key_owner',
			permissions: FULL_API_KEY_PERMISSIONS
		};
		t.sqlite
			.prepare(
				'INSERT INTO api_key (id,user_id,name,key_hash,key_prefix,created_at) VALUES (?,?,?,?,?,?)'
			)
			.run('key_owner', owner.userId, 'Owner key', 'owner_key_hash', 'ownerkey', Date.now());
		const issue = await createIssue(
			t.db,
			t.env,
			keyOwner,
			TEST_NOOP_DISPATCH_EFFECTS,
			'prj_shared',
			{ title: 'Visible issue', description: 'Visible body' }
		);
		const now = Date.now();
		t.sqlite
			.prepare(
				`INSERT INTO context_item (id,user_id,kind,name,description,project_id,workflow_state_id,issue_id,label_id,body,position,version,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
			)
			.run(
				'ctx_secret',
				'owner',
				'prompt',
				'private-prompt',
				'',
				null,
				null,
				issue.id,
				null,
				'PRIVATE_CANARY',
				0,
				1,
				now,
				now
			);
		const detail = await readSharedIssue(t.db, member, { id: issue.id });
		expect(detail).toMatchObject({ title: 'Visible issue', viewer_role: 'member' });
		expect(JSON.stringify(detail)).not.toContain('PRIVATE_CANARY');
		await expect(readSharedIssue(t.db, outsider, { id: issue.id })).rejects.toMatchObject({
			status: 404
		});
		t.sqlite
			.prepare(
				'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)'
			)
			.run('other_owner', 'Other Owner', 'other@test.invalid', 1, now, now);
		t.sqlite
			.prepare(
				'INSERT INTO project (id,user_id,name,description,shared_at,sharing_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
			)
			.run('prj_other', 'other_owner', 'A project', '', now, 1, now, now);
		t.sqlite
			.prepare(
				'INSERT INTO project_member (project_id,user_id,revision,joined_at,updated_at) VALUES (?,?,?,?,?)'
			)
			.run('prj_other', 'member', 1, now, now);
		await expect(resolveAccessibleProjectRef(t.db, member, 'A project')).rejects.toMatchObject({
			status: 409,
			code: 'ambiguous_project'
		});
		expect(await resolveAccessibleProjectRef(t.db, member, 'prj_shared')).toBe('prj_shared');
	});
});
