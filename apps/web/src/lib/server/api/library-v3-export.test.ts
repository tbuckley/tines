import { expect, it } from 'vitest';
import { parseLibraryV3Document } from '@tines/shared';
import { USER, seedBase } from '../supervisor/test-fixtures';
import { createTestDb } from './test-db';
import { createWorkflow } from './workflows';
import { createContextItem } from './context';
import { buildLibraryV3Document } from './library-v3-export';

it('exports duplicate workflow names and state prompts by distinct local IDs without writing', async () => {
	const t = createTestDb();
	seedBase(t);
	const actor = {
		userId: USER,
		userName: 'Alice',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};
	for (const [index, body] of ['First instructions', 'Second instructions'].entries()) {
		const workflow = await createWorkflow(t.db, t.env, actor, {
			name: 'Same',
			initial_state: 'Ready',
			states: [{ name: 'Ready', category: 'active' }],
			transitions: []
		});
		const context = await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'instructions',
			body,
			workflow_state_id: workflow.states[0].id
		});
		await t.db
			.updateTable('workflow')
			.set({ created_at: (index + 1) * 10 })
			.where('id', '=', workflow.id)
			.execute();
		await t.db
			.updateTable('context_item')
			.set({ created_at: (index + 1) * 10 })
			.where('id', '=', context.id)
			.execute();
	}
	const before = await t.db.selectFrom('event').selectAll().execute();
	const document = await buildLibraryV3Document(t.db, USER);
	expect(document.workflows.map((w) => w.name)).toEqual(['Same', 'Same']);
	expect(new Set(document.workflows.map((w) => w.id)).size).toBe(2);
	expect(document.context.map((c) => (c.kind === 'prompt' ? c.body : ''))).toEqual([
		'First instructions',
		'Second instructions'
	]);
	for (const [i, w] of document.workflows.entries()) {
		expect(document.context[i].scope.state).toEqual({
			kind: 'bundled_state',
			state_id: w.states[0].id
		});
		expect(w.states[0].inherits_from).toBeNull();
	}
	expect(await parseLibraryV3Document(JSON.stringify(document))).toEqual(document);
	expect(await t.db.selectFrom('event').selectAll().execute()).toEqual(before);
});

it('preserves ordinary local repository declarations in whole-library backups', async () => {
	const t = createTestDb();
	seedBase(t);
	const actor = {
		userId: USER,
		userName: 'Alice',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};
	await createContextItem(t.db, t.env, actor, {
		kind: 'repo',
		name: 'local-runner-source',
		repo_url: 'file:///tmp/local-runner-source'
	});
	const document = await buildLibraryV3Document(t.db, USER);
	expect(document.context).toContainEqual(
		expect.objectContaining({
			kind: 'repo',
			name: 'local-runner-source',
			repo_url: 'file:///tmp/local-runner-source'
		})
	);
	expect(await parseLibraryV3Document(JSON.stringify(document))).toEqual(document);
});

it.each([100, 101, 181])('exports %i skills with ordered file contents', async (count) => {
	const t = createTestDb();
	seedBase(t);
	const actor = {
		userId: USER,
		userName: 'Alice',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};
	for (let index = 0; index < count; index++) {
		await createContextItem(t.db, t.env, actor, {
			kind: 'skill',
			name: `skill-${index.toString().padStart(3, '0')}`,
			files: [
				{ path: 'z.txt', content: `last-${index}` },
				{ path: 'SKILL.md', content: `first-${index}` }
			]
		});
	}
	t.sqlite.exec(`
		INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u2', 'bob', 'b@example.com', 1, 0, 0);
		INSERT INTO context_item
			(id, user_id, kind, name, description, position, version, created_at, updated_at)
			VALUES ('ctx_foreign', 'u2', 'skill', 'foreign', '', 0, 1, 0, 0);
		INSERT INTO context_item_file
			(id, context_item_id, path, content, created_at, updated_at)
			VALUES ('ctf_foreign', 'ctx_foreign', 'SKILL.md', 'foreign', 0, 0);
	`);

	const document = await buildLibraryV3Document(t.db, USER);
	expect(document.context).toHaveLength(count);
	expect(document.context.map((item) => item.name)).toEqual(
		Array.from({ length: count }, (_, index) => `skill-${index.toString().padStart(3, '0')}`)
	);
	for (const index of [0, Math.min(89, count - 1), count - 1]) {
		const item = document.context[index];
		expect(item.kind).toBe('skill');
		if (item.kind !== 'skill') continue;
		expect(item.files).toEqual([
			{ id: expect.any(String), path: 'SKILL.md', content: `first-${index}` },
			{ id: expect.any(String), path: 'z.txt', content: `last-${index}` }
		]);
	}
	expect(document.context.some((item) => item.name === 'foreign')).toBe(false);
	expect(await parseLibraryV3Document(JSON.stringify(document))).toEqual(document);
});
