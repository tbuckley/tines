import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createTestDb } from './test-db';
import { USER, seedBase } from '../supervisor/test-fixtures';
import { runAtomic } from './core';
import {
	validateWorkflowCreateFields,
	resolveInheritance,
	workflowInsertQueries
} from './workflows';

const actor = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};
async function fixture() {
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
	// Workflow-level cycle, but two independent state edges, neither a state cycle nor excessive depth.
	defs[0].def.states[0].inheritsFrom = defs[1].def.states[1].id;
	defs[1].def.states[0].inheritsFrom = defs[0].def.states[1].id;
	const inh = await resolveInheritance(
		t.db,
		USER,
		{ id: null, name: 'Package' },
		defs.flatMap((d) => d.def.states),
		[]
	);
	const options = defs.map((d, i) => ({
		...d,
		id: `wf_guard_${i}`,
		inh,
		now: 123,
		eventId: `evt_guard_${i}`,
		promptIds: { [d.def.states[0].id]: { id: `ctx_guard_${i}`, eventId: `evt_prompt_${i}` } }
	}));
	return { t, options };
}
describe('guarded ordinary workflow builders', () => {
	it('false guard skips every workflow, state, transition, prompt, pointer and event statement', async () => {
		const { t, options } = await fixture();
		const before = await t.db.selectFrom('workflow').selectAll().execute();
		const guard = { predicate: sql<boolean>`0` };
		await runAtomic(
			t.env,
			options.flatMap((opts) => workflowInsertQueries(t.db, actor, { ...opts, guard }))
		);
		expect(await t.db.selectFrom('workflow').selectAll().execute()).toEqual(before);
		expect(await t.db.selectFrom('context_item').selectAll().execute()).toEqual([]);
		expect(await t.db.selectFrom('event').selectAll().execute()).toEqual([]);
	});
	it('phases allow cross-workflow inheritance, reuse allocated IDs, and guard pointer updates independently', async () => {
		const { t, options } = await fixture();
		const shells = options.flatMap((opts) =>
			workflowInsertQueries(t.db, actor, {
				...opts,
				guard: { predicate: sql<boolean>`1` },
				phase: 'shells'
			})
		);
		const blockedPointers = options.flatMap((opts) =>
			workflowInsertQueries(t.db, actor, {
				...opts,
				guard: { predicate: sql<boolean>`0` },
				phase: 'inheritance'
			})
		);
		await runAtomic(t.env, [...shells, ...blockedPointers]);
		const starts = options.map((o) => o.def.states[0].id);
		expect(
			(
				await t.db
					.selectFrom('workflow_state')
					.select('inherits_from_state_id')
					.where('id', 'in', starts)
					.execute()
			).every((s) => s.inherits_from_state_id === null)
		).toBe(true);
		await runAtomic(
			t.env,
			options.flatMap((opts) =>
				workflowInsertQueries(t.db, actor, {
					...opts,
					guard: { predicate: sql<boolean>`1` },
					phase: 'inheritance'
				})
			)
		);
		for (const opts of options)
			expect(
				await t.db
					.selectFrom('workflow_state')
					.select('inherits_from_state_id')
					.where('id', '=', opts.def.states[0].id)
					.executeTakeFirstOrThrow()
			).toEqual({ inherits_from_state_id: opts.def.states[0].inheritsFrom });
		expect(
			(await t.db.selectFrom('event').select(['id', 'created_at']).execute()).sort((a, b) =>
				a.id.localeCompare(b.id)
			)
		).toEqual([
			{ id: 'evt_guard_0', created_at: 123 },
			{ id: 'evt_guard_1', created_at: 123 },
			{ id: 'evt_prompt_0', created_at: 123 },
			{ id: 'evt_prompt_1', created_at: 123 }
		]);
		expect(
			(await t.db.selectFrom('context_item').select('id').execute()).map((c) => c.id).sort()
		).toEqual(['ctx_guard_0', 'ctx_guard_1']);
	});
	it('a late inheritance constraint failure rolls back all shells and events in the batch', async () => {
		const { t, options } = await fixture();
		const guard = { predicate: sql<boolean>`1` };
		const shells = options.flatMap((opts) =>
			workflowInsertQueries(t.db, actor, { ...opts, guard, phase: 'shells' })
		);
		const failure = t.db
			.updateTable('workflow_state')
			.set({ inherits_from_state_id: 'missing' })
			.where('id', '=', options[0].def.states[0].id)
			.compile();
		await expect(runAtomic(t.env, [...shells, failure])).rejects.toThrow();
		expect(
			await t.db.selectFrom('workflow').selectAll().where('user_id', '=', USER).execute()
		).toEqual([]);
		expect(await t.db.selectFrom('event').selectAll().execute()).toEqual([]);
		expect(await t.db.selectFrom('context_item').selectAll().execute()).toEqual([]);
	});
});
