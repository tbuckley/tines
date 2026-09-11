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
			states: [{ name: 'Ready', category: 'active', inherits_from: 'wfs_std_open' }],
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
		expect(w.states[0].inherits_from).toEqual({
			kind: 'system_state',
			workflow: 'Standard',
			state_name: 'Open'
		});
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
