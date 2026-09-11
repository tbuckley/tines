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

import { contextItemInsertQueries, validateContextCreateFields } from './context';
import { labelInsertQueries } from './labels';
import { routingRuleInsertQueries } from './routing';
import { scheduleInsertQueries, prepareSchedule, resolveStartState } from './schedules';
import { resolveScope } from './scope';
import { OPEN, PROJECT } from '../supervisor/test-fixtures';

async function objectFixture(enabled: boolean) {
	const t = createTestDb();
	seedBase(t);
	const now = Date.now();
	const guard = { predicate: sql<boolean>`${enabled ? 1 : 0}` };
	const scope = await resolveScope(t.db, USER, {
		projectId: null,
		workflowStateId: OPEN,
		labelId: null,
		issueId: null
	});
	const context = [
		{ kind: 'prompt' as const, name: 'instructions', body: 'Keep this prose' },
		{
			kind: 'skill' as const,
			name: 'review',
			files: [
				{ path: 'SKILL.md', content: 'Review carefully' },
				{ path: 'scripts/check.txt', content: 'nested file' }
			]
		},
		{
			kind: 'repo' as const,
			name: 'source',
			repo_url: 'https://example.com/source.git',
			repo_branch: 'main',
			repo_dir: 'source'
		}
	].flatMap((body, i) =>
		contextItemInsertQueries(t.db, actor, {
			id: `ctx_${i}`,
			fields: validateContextCreateFields(body),
			scope,
			position: i,
			now,
			guard,
			eventId: `evt_ctx_${i}`,
			...(i === 1 ? { fileIds: ['ctf_skill', 'ctf_script'] } : {})
		})
	);
	const label = labelInsertQueries(
		t.db,
		actor,
		{
			id: 'lbl_package',
			name: 'review',
			color: 'blue',
			description: 'Destination label',
			created_at: now,
			updated_at: now
		},
		{ guard, eventId: 'evt_label' }
	);
	const schedule = await prepareSchedule(
		t.db,
		PROJECT,
		{
			name: 'Daily',
			cron: '0 9 * * *',
			timezone: 'UTC',
			require_all_closed: true
		},
		'Review {{date}}',
		now
	);
	const schedules = scheduleInsertQueries(t.db, actor, {
		schedule,
		projectId: PROJECT,
		workflowId: 'wf_standard',
		stateId: OPEN,
		stateName: 'Open',
		titleTemplate: 'Review {{date}}',
		descriptionTemplate: 'Literal {{run}}',
		now,
		guard,
		eventId: 'evt_schedule'
	});
	const routing = routingRuleInsertQueries(t.db, actor, {
		id: 'rul_package',
		scope: { projectId: PROJECT, workflowStateId: OPEN, labelId: null },
		label: 'project demo · state Standard / Open',
		targets: [{ runner_id: '*', tier: 'balanced' }],
		runnersById: new Map(),
		now,
		guard,
		eventId: 'evt_routing'
	});
	return { t, now, schedule, queries: [...context, ...label, ...schedules, ...routing] };
}

describe('guarded ordinary context, label, schedule and routing builders', () => {
	it('false guard writes no children, objects, events or initial issue', async () => {
		const { t, queries } = await objectFixture(false);
		await runAtomic(t.env, queries);
		for (const table of [
			'context_item',
			'context_item_file',
			'label',
			'scheduled_task',
			'routing_rule',
			'event',
			'issue'
		] as const)
			expect(await t.db.selectFrom(table).selectAll().execute(), table).toEqual([]);
	});
	it('creates ordinary ordered version-1 payloads with allocated IDs and paused schedules only', async () => {
		const { t, queries, schedule, now } = await objectFixture(true);
		await runAtomic(t.env, queries);
		const contexts = await t.db
			.selectFrom('context_item')
			.selectAll()
			.orderBy('position')
			.execute();
		expect(contexts.map((c) => [c.id, c.kind, c.position, c.version])).toEqual([
			['ctx_0', 'prompt', 0, 1],
			['ctx_1', 'skill', 1, 1],
			['ctx_2', 'repo', 2, 1]
		]);
		expect(contexts[0].body).toBe('Keep this prose');
		expect(contexts[2]).toMatchObject({
			repo_url: 'https://example.com/source.git',
			repo_branch: 'main',
			repo_dir: 'source'
		});
		expect(
			await t.db
				.selectFrom('context_item_file')
				.select(['id', 'path', 'content'])
				.orderBy('path')
				.execute()
		).toEqual([
			{ id: 'ctf_skill', path: 'SKILL.md', content: 'Review carefully' },
			{ id: 'ctf_script', path: 'scripts/check.txt', content: 'nested file' }
		]);
		expect(
			await t.db.selectFrom('scheduled_task').selectAll().executeTakeFirstOrThrow()
		).toMatchObject({
			id: schedule.id,
			enabled: 0,
			last_run_at: null,
			run_count: 0,
			state_id: OPEN,
			title_template: 'Review {{date}}',
			description_template: 'Literal {{run}}',
			next_run_at: schedule.nextRunAt
		});
		expect(schedule.nextRunAt).toBeGreaterThan(now);
		expect(await t.db.selectFrom('issue').selectAll().execute()).toEqual([]);
		expect(
			await t.db.selectFrom('project').select('default_workflow_id').executeTakeFirstOrThrow()
		).toEqual({ default_workflow_id: null });
		const events = await t.db.selectFrom('event').selectAll().execute();
		expect(events.map((e) => e.id).sort()).toEqual([
			'evt_ctx_0',
			'evt_ctx_1',
			'evt_ctx_2',
			'evt_label',
			'evt_routing',
			'evt_schedule'
		]);
		expect(events.every((e) => e.created_at === now && e.actor_user_id === USER)).toBe(true);
		expect(JSON.parse(events.find((e) => e.id === 'evt_schedule')!.payload)).toMatchObject({
			enabled: false,
			initial_issue_created: false
		});
		expect(
			await t.db.selectFrom('routing_rule').select('targets').executeTakeFirstOrThrow()
		).toEqual({ targets: '[{"runner_id":"*","tier":"balanced"}]' });
	});
	for (const table of ['context_item_file', 'label', 'scheduled_task', 'routing_rule'] as const) {
		it(`rolls back the whole batch when ${table} violates a constraint`, async () => {
			const { t, queries } = await objectFixture(true);
			t.sqlite.exec(
				`CREATE TRIGGER refuse_package BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`
			);
			await expect(runAtomic(t.env, queries)).rejects.toThrow('injected failure');
			for (const name of [
				'context_item',
				'context_item_file',
				'label',
				'scheduled_task',
				'routing_rule',
				'event',
				'issue'
			] as const)
				expect(await t.db.selectFrom(name).selectAll().execute(), name).toEqual([]);
		});
	}
	it('a strict label collision fails instead of silently substituting another identity', async () => {
		const { t, queries } = await objectFixture(true);
		t.sqlite.exec(
			`INSERT INTO label (id,user_id,name,color,description,created_at,updated_at) VALUES ('other','${USER}','REVIEW','blue','',1,1)`
		);
		await expect(runAtomic(t.env, queries)).rejects.toThrow();
		expect(await t.db.selectFrom('context_item').selectAll().execute()).toEqual([]);
		expect(await t.db.selectFrom('event').selectAll().execute()).toEqual([]);
	});
	it('preserves an explicitly selected initial state for packages while retaining ordinary follow-initial semantics', () => {
		const workflow = {
			id: 'wf_standard',
			name: 'Standard',
			initial_state_id: OPEN,
			states: [{ id: OPEN, name: 'Open' }]
		};
		expect(resolveStartState(workflow, OPEN)).toBeNull();
		expect(resolveStartState(workflow, OPEN, { preserveExplicitInitial: true })).toBe(OPEN);
		expect(() => resolveStartState(workflow, 'missing', { preserveExplicitInitial: true })).toThrow(
			'has no state'
		);
	});
});
