import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createTestDb } from './test-db';
import { USER, seedBase } from '../supervisor/test-fixtures';
import { runAtomic } from './core';
import { validateWorkflowCreateFields, workflowInsertQueries } from './workflows';

const actor = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

function fixture() {
	const t = createTestDb();
	seedBase(t);
	const defs = ['A', 'B'].map((name) =>
		validateWorkflowCreateFields({
			name,
			initial_state: 'Start',
			states: [
				{ name: 'Start', category: 'active', prompt: `${name} instructions` },
				{ name: 'End', category: 'done' }
			],
			transitions: [{ name: 'Finish', from: 'Start', to: 'End' }]
		})
	);
	const options = defs.map((d, i) => ({
		...d,
		id: `wf_guard_${i}`,
		now: 123,
		eventId: `evt_guard_${i}`,
		promptIds: { [d.def.states[0].id]: { id: `ctx_guard_${i}`, eventId: `evt_prompt_${i}` } }
	}));
	return { t, options };
}

describe('guarded ordinary workflow builders', () => {
	it('a false guard skips every workflow, state, transition, prompt and event statement', async () => {
		const { t, options } = fixture();
		const before = await t.db.selectFrom('workflow').selectAll().execute();
		await runAtomic(
			t.env,
			options.flatMap((opts) =>
				workflowInsertQueries(t.db, actor, { ...opts, guard: { predicate: sql<boolean>`0` } })
			)
		);
		expect(await t.db.selectFrom('workflow').selectAll().execute()).toEqual(before);
		expect(await t.db.selectFrom('context_item').selectAll().execute()).toEqual([]);
		expect(await t.db.selectFrom('event').selectAll().execute()).toEqual([]);
	});

	it('ordinary guarded creation preserves exact-state null pointers and prompt seeds', async () => {
		const { t, options } = fixture();
		await runAtomic(
			t.env,
			options.flatMap((opts) =>
				workflowInsertQueries(t.db, actor, { ...opts, guard: { predicate: sql<boolean>`1` } })
			)
		);
		expect(
			(await t.db.selectFrom('workflow_state').select('inherits_from_state_id').execute()).every(
				(s) => s.inherits_from_state_id === null
			)
		).toBe(true);
		expect(
			(await t.db.selectFrom('context_item').select('id').execute()).map((c) => c.id).sort()
		).toEqual(['ctx_guard_0', 'ctx_guard_1']);
	});
});
