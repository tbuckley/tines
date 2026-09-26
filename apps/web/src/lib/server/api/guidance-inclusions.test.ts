import { describe, expect, it } from 'vitest';
import { FULL_API_KEY_PERMISSIONS } from '@tines/shared';
import { createTestDb } from './test-db';
import type { ActorContext } from './core';
import {
	excludeItem,
	includeItem,
	listInclusionCandidates,
	listInclusions
} from './guidance-inclusions';

const human = (userId: string): ActorContext => ({
	userId,
	userName: userId,
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
});
const owner = human('owner');

function fixture({ flag = 'on' }: { flag?: string } = {}) {
	const t = createTestDb();
	const now = Date.now();
	for (const id of ['owner', 'member', 'outsider'])
		t.sqlite
			.prepare(
				'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)'
			)
			.run(id, id, `${id}@test.invalid`, 1, now, now);
	t.sqlite
		.prepare(
			'INSERT INTO project (id,user_id,name,description,created_at,updated_at,shared_at) VALUES (?,?,?,?,?,?,?)'
		)
		.run('prj', 'owner', 'Shared', '', now, now, now);
	t.sqlite
		.prepare(
			'INSERT INTO project_member (project_id,user_id,revision,joined_at,updated_at) VALUES (?,?,?,?,?)'
		)
		.run('prj', 'member', 1, now, now);
	t.sqlite
		.prepare('INSERT INTO label (id,user_id,name,color,created_at,updated_at) VALUES (?,?,?,?,?,?)')
		.run('lbl', 'owner', 'ops', '#fff', now, now);
	const item = (id: string, kind: string, scope: { project?: string; label?: string } = {}) =>
		t.sqlite
			.prepare(
				`INSERT INTO context_item (id,user_id,kind,name,description,project_id,label_id,body,env_value,position,version,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
			)
			.run(
				id,
				'owner',
				kind,
				id,
				'',
				scope.project ?? null,
				scope.label ?? null,
				kind === 'prompt' ? 'body' : null,
				kind === 'env' ? 'v' : null,
				0,
				1,
				now,
				now
			);
	item('ci_global', 'prompt');
	item('ci_label', 'prompt', { label: 'lbl' });
	item('ci_project', 'prompt', { project: 'prj' });
	item('ci_env', 'env');
	const env = { ...t.env, SHARED_EXECUTION: flag } as unknown as Env;
	return { ...t, env };
}

describe('guidance inclusions', () => {
	it('includes a global or label-only item idempotently and records owner events', async () => {
		const t = fixture();
		const first = await includeItem(t.db, t.env, owner, 'prj', { item_id: 'ci_global' });
		expect(first).toMatchObject({
			created: true,
			inclusion: { kind: 'prompt', name: 'ci_global' }
		});
		const again = await includeItem(t.db, t.env, owner, 'prj', { item_id: 'ci_global' });
		expect(again.created).toBe(false);
		await includeItem(t.db, t.env, owner, 'prj', { item_id: 'ci_label' });
		const listed = await listInclusions(t.db, t.env, owner, 'prj');
		expect(listed.items.map((i) => [i.item_id, i.scope_label])).toEqual([
			['ci_global', 'global'],
			['ci_label', 'label ops']
		]);
		expect(
			(await listInclusionCandidates(t.db, t.env, owner, 'prj')).map((c) => c.item_id)
		).toEqual([]);
		await excludeItem(t.db, t.env, owner, 'prj', 'ci_global');
		await expect(excludeItem(t.db, t.env, owner, 'prj', 'ci_global')).rejects.toMatchObject({
			status: 404
		});
		expect(t.all('SELECT type FROM event ORDER BY created_at, rowid')).toEqual([
			{ type: 'project.guidance_included' },
			{ type: 'project.guidance_included' },
			{ type: 'project.guidance_excluded' }
		]);
	});

	it('refuses items that share automatically or never', async () => {
		const t = fixture();
		for (const item_id of ['ci_project', 'ci_env', 'missing'])
			await expect(includeItem(t.db, t.env, owner, 'prj', { item_id })).rejects.toMatchObject({
				status: 422,
				code: 'inclusion_not_admissible'
			});
		expect(t.all('SELECT * FROM project_guidance_inclusion')).toEqual([]);
	});

	it('is owner-only, human-only and flag-gated', async () => {
		const t = fixture();
		await expect(listInclusions(t.db, t.env, human('member'), 'prj')).rejects.toMatchObject({
			status: 403,
			code: 'owner_only'
		});
		await expect(listInclusions(t.db, t.env, human('outsider'), 'prj')).rejects.toMatchObject({
			status: 404
		});
		await expect(
			includeItem(t.db, t.env, { ...owner, agentRunId: 'run_1' }, 'prj', { item_id: 'ci_global' })
		).rejects.toMatchObject({ status: 403, code: 'run_key_forbidden' });
		const readKey: ActorContext = {
			...owner,
			viaSession: false,
			apiKeyId: 'key_read',
			permissions: { ...FULL_API_KEY_PERMISSIONS, projects: { access: 'read', scope: ['prj'] } }
		};
		await expect(listInclusions(t.db, t.env, readKey, 'prj')).resolves.toEqual({ items: [] });
		await expect(
			includeItem(t.db, t.env, readKey, 'prj', { item_id: 'ci_global' })
		).rejects.toMatchObject({ code: 'insufficient_permissions' });
		const off = fixture({ flag: '' });
		await expect(listInclusions(off.db, off.env, owner, 'prj')).rejects.toMatchObject({
			status: 404
		});
	});
});
