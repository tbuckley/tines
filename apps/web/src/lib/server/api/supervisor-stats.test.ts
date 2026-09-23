import { beforeEach, describe, expect, it, vi } from 'vitest';

const statsCalls = vi.hoisted(() => ({ preparations: 0 }));
vi.mock('$lib/server/supervisor/stats', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/supervisor/stats')>();
	return {
		...actual,
		prepareStageStats: (input: Parameters<typeof actual.prepareStageStats>[0]) => {
			statsCalls.preparations++;
			return actual.prepareStageStats(input);
		}
	};
});
import { createTestDb, type TestDb } from './test-db';
import { loadSentBackDrilldown, loadStageStats, parseStatsWindow } from './supervisor';
import { TEST_NOOP_DISPATCH_EFFECTS } from './test-dispatch-effects';
import { updateWorkflow } from './workflows';
import type { ActorContext } from './core';
import {
	addIssue,
	addComment,
	addRun,
	addRunKey,
	addRunner,
	addTransitionEvent,
	addTwoStageWorkflow,
	NOW,
	OPEN,
	REVIEW,
	PROJECT,
	seedBase,
	STAGE_A,
	STAGE_B,
	USER
} from '$lib/server/supervisor/test-fixtures';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const actor: ActorContext = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

beforeEach(() => {
	statsCalls.preparations = 0;
});

function setup(): TestDb {
	const t = createTestDb();
	seedBase(t);
	addTwoStageWorkflow(t);
	addRunner(t, { id: 'rnr_1', name: 'macbook-claude' });
	return t;
}

/** A second project, so the `?project=` filter has something to exclude. */
function addOtherProject(t: TestDb): string {
	t.sqlite.exec(
		`INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('prj_other', '${USER}', 'other', ${NOW}, ${NOW});`
	);
	return 'prj_other';
}

describe('parseStatsWindow', () => {
	it('defaults to 7d and rejects what it cannot bound', () => {
		expect(parseStatsWindow(undefined)).toBe(7 * DAY);
		expect(parseStatsWindow('24h')).toBe(24 * HOUR);
		expect(() => parseStatsWindow('week')).toThrow(/window/);
		expect(() => parseStatsWindow('30m')).toThrow(/window/);
		expect(() => parseStatsWindow('91d')).toThrow(/between 1h and 90d/);
	});
});

describe('loadStageStats', () => {
	it('reclassifies historical send-backs after the workflow order is saved', async () => {
		const t = setup();
		const issue = addIssue(t, { id: 'iss_reordered', state: STAGE_A, workflow: 'wf_two' });
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - DAY,
			from: STAGE_B,
			to: STAGE_A
		});

		const before = await loadStageStats(t.db, USER, {}, NOW);
		expect(before.states.find((state) => state.state_id === STAGE_B)?.current).toMatchObject({
			exits: 1,
			sent_back: { count: 1 }
		});
		expect((await loadSentBackDrilldown(t.db, USER, { state: STAGE_B }, NOW)).items).toHaveLength(
			1
		);

		await updateWorkflow(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, 'wf_two', {
			states: [
				{ id: STAGE_B, name: 'Stage B', category: 'active' },
				{ id: STAGE_A, name: 'Stage A', category: 'active' },
				{ id: 'wfs_two_done', name: 'Done', category: 'done' }
			]
		});

		const after = await loadStageStats(t.db, USER, {}, NOW);
		expect(after.states.find((state) => state.state_id === STAGE_B)?.current).toMatchObject({
			exits: 1,
			sent_back: { count: 0 }
		});
		expect((await loadSentBackDrilldown(t.db, USER, { state: STAGE_B }, NOW)).items).toEqual([]);
	});

	it('builds visits, queue wait and the agent-attributed sent back from stored rows', async () => {
		const t = setup();
		const issue = addIssue(t, { id: 'iss_1', state: STAGE_B, workflow: 'wf_two' });
		// Entered Review two days ago, one run started an hour later, then a
		// run key sent it back to Open.
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - 2 * DAY,
			from: STAGE_A,
			to: STAGE_B
		});
		const run = addRun(t, {
			issueId: issue,
			runnerId: 'rnr_1',
			stateAtStart: STAGE_B,
			status: 'completed',
			outcome: 'advanced',
			createdAt: NOW - 2 * DAY + 10 * MIN,
			startedAt: NOW - 2 * DAY + HOUR,
			endedAt: NOW - 2 * DAY + 2 * HOUR
		});
		const key = addRunKey(t, run);
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: key,
			at: NOW - DAY,
			from: STAGE_B,
			to: STAGE_A
		});

		const report = await loadStageStats(t.db, USER, {}, NOW);
		expect(report.window.ms).toBe(7 * DAY);
		expect(report.previous).toEqual({ since: NOW - 14 * DAY, until: NOW - 7 * DAY });
		const review = report.states.find((s) => s.state_id === STAGE_B);
		expect(review).toBeDefined();
		expect(review?.current.visits).toBe(1);
		expect(review?.current.exits).toBe(1);
		expect(review?.current.queue_wait?.p50).toBe(HOUR);
		expect(review?.current.work?.p50).toBe(DAY - HOUR);
		expect(review?.current.runs.total).toBe(1);
		expect(review?.current.runs.outcomes.advanced).toBe(1);
		// The exit was authored by a run key: an agent sent it back.
		expect(review?.current.sent_back).toMatchObject({ count: 1, agent: 1, human: 0 });
		expect(review?.current.sent_back.by_target[0].state_id).toBe(STAGE_A);
		expect(report.states.find((s) => s.state_id === STAGE_A)?.current.received_back).toBe(1);
	});

	it('attributes a transition with no key to a human', async () => {
		const t = setup();
		const issue = addIssue(t, { id: 'iss_1', state: STAGE_A, workflow: 'wf_two' });
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - 3 * DAY,
			from: STAGE_A,
			to: STAGE_B
		});
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - 2 * DAY,
			from: STAGE_B,
			to: STAGE_A
		});
		const report = await loadStageStats(t.db, USER, {}, NOW);
		expect(report.states.find((s) => s.state_id === STAGE_B)?.current.sent_back).toMatchObject({
			count: 1,
			agent: 0,
			human: 1
		});
	});

	it('narrows to one project and 404s on a name that matches nothing', async () => {
		const t = setup();
		const other = addOtherProject(t);
		const mine = addIssue(t, { id: 'iss_mine', state: STAGE_B, workflow: 'wf_two' });
		addTransitionEvent(t, {
			issueId: mine,
			apiKeyId: null,
			at: NOW - DAY,
			from: STAGE_A,
			to: STAGE_B
		});
		// The other project's event carries its own project_id.
		const theirs = addIssue(t, {
			id: 'iss_theirs',
			state: STAGE_B,
			workflow: 'wf_two',
			project: other
		});
		t.sqlite
			.prepare(
				`INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
				VALUES ('evt_other', ?, 'issue.transitioned', ?, NULL, ?, ?, ?, ?)`
			)
			.run(
				USER,
				USER,
				theirs,
				other,
				JSON.stringify({ from_state_id: STAGE_A, to_state_id: STAGE_B }),
				NOW - DAY
			);

		const all = await loadStageStats(t.db, USER, {}, NOW);
		expect(all.states.find((s) => s.state_id === STAGE_B)?.current.visits).toBe(2);
		const scoped = await loadStageStats(t.db, USER, { project: 'demo' }, NOW);
		expect(scoped.project).toEqual({ id: PROJECT, name: 'demo' });
		expect(scoped.states.find((s) => s.state_id === STAGE_B)?.current.visits).toBe(1);
		await expect(loadStageStats(t.db, USER, { project: 'nope' }, NOW)).rejects.toThrow(
			/No project "nope"/
		);
	});

	it('reads an entry off issue.created and rejects a bad compare', async () => {
		const t = setup();
		const issue = addIssue(t, { id: 'iss_1', state: STAGE_B, workflow: 'wf_two' });
		t.sqlite
			.prepare(
				`INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
				VALUES ('evt_c', ?, 'issue.created', ?, NULL, ?, ?, ?, ?)`
			)
			.run(
				USER,
				USER,
				issue,
				PROJECT,
				JSON.stringify({ state_id: STAGE_B, state_name: 'Stage B' }),
				NOW - DAY
			);
		const report = await loadStageStats(t.db, USER, { compare: 'none' }, NOW);
		expect(report.previous).toBeNull();
		const stage = report.states.find((s) => s.state_id === STAGE_B);
		expect(stage?.current.visits).toBe(1);
		expect(stage?.current.waiting_now).toBe(1);
		await expect(
			loadStageStats(t.db, USER, { compare: 'both' as 'previous' }, NOW)
		).rejects.toThrow(/compare/);
	});

	it('resolves historical workflow changes from workflow and state names', async () => {
		const t = setup();
		t.sqlite.exec(`
			INSERT INTO workflow (id, user_id, name, initial_state_id, created_at, updated_at)
			VALUES ('wf_old', '${USER}', 'Old flow', 'wfs_old_open', ${NOW}, ${NOW});
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at)
			VALUES ('wfs_old_open', 'wf_old', 'Old open', 'active', 0, ${NOW});
		`);
		const issue = addIssue(t, { id: 'iss_old_move', state: STAGE_B, workflow: 'wf_two' });
		t.sqlite
			.prepare(
				`INSERT INTO event (id, user_id, type, actor_user_id, issue_id, project_id, payload, created_at)
				 VALUES ('evt_old_move', ?, 'issue.updated', ?, ?, ?, ?, ?)`
			)
			.run(
				USER,
				USER,
				issue,
				PROJECT,
				JSON.stringify({
					changed: ['workflow'],
					workflow_from_id: 'wf_old',
					workflow_to_id: 'wf_two',
					from_state_name: 'Old open',
					to_state_name: 'Stage B'
				}),
				NOW - DAY
			);
		const report = await loadStageStats(t.db, USER, {}, NOW);
		expect(report.states.find((stage) => stage.state_id === STAGE_B)?.current.visits).toBe(1);
		expect(report.states.find((stage) => stage.state_id === 'wfs_old_open')?.current.exits).toBe(1);
	});

	it('ignores events whose issue was deleted', async () => {
		const t = setup();
		const issue = addIssue(t, { id: 'iss_1', state: STAGE_B, workflow: 'wf_two' });
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - DAY,
			from: STAGE_A,
			to: STAGE_B
		});
		t.sqlite.exec(`UPDATE event SET issue_id = NULL`);
		expect((await loadStageStats(t.db, USER, {}, NOW)).states).toEqual([]);
	});

	it('reports the oldest recorded outcome so the UI can blank stale deltas', async () => {
		const t = setup();
		const issue = addIssue(t, { id: 'iss_1', state: STAGE_B, workflow: 'wf_two' });
		addRun(t, {
			issueId: issue,
			runnerId: 'rnr_1',
			status: 'completed',
			outcome: 'stalled',
			createdAt: NOW - 3 * DAY,
			startedAt: NOW - 3 * DAY,
			endedAt: NOW - 3 * DAY + HOUR
		});
		expect((await loadStageStats(t.db, USER, {}, NOW)).outcome_recorded_since).toBe(
			NOW - 3 * DAY + HOUR
		);
	});

	it('reports quota changes with before/after figures', async () => {
		const t = setup();
		const issue = addIssue(t, { id: 'iss_marker', state: STAGE_B, workflow: 'wf_two' });
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - 3 * DAY,
			from: STAGE_A,
			to: STAGE_B
		});
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - 2 * DAY,
			from: STAGE_B,
			to: STAGE_A
		});
		t.sqlite
			.prepare(
				`INSERT INTO event (id, user_id, type, actor_user_id, payload, created_at) VALUES ('evt_quota', ?, 'settings.updated', ?, ?, ?)`
			)
			.run(USER, USER, JSON.stringify({ changed: ['quota'] }), NOW - DAY);

		const report = await loadStageStats(t.db, USER, {}, NOW);
		expect(report.markers[0]).toMatchObject({ kind: 'quota', label: 'Supervisor quota changed' });
		expect(
			report.markers[0].effects.find((effect) => effect.state_id === STAGE_B)?.before
		).toMatchObject({ exits: 1, sent_back_share: 1 });
	});

	it('project filters rule markers and scopes stage rules to their affected state', async () => {
		const t = setup();
		const other = addOtherProject(t);
		const issue = addIssue(t, { id: 'iss_marker_scope', state: STAGE_B, workflow: 'wf_two' });
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - DAY,
			from: STAGE_A,
			to: STAGE_B
		});
		t.sqlite
			.prepare(
				`INSERT INTO event (id, user_id, type, actor_user_id, project_id, payload, created_at) VALUES
				 ('evt_rule_mine', ?, 'routing_rule.updated', ?, ?, ?, ?),
				 ('evt_rule_other', ?, 'routing_rule.updated', ?, ?, ?, ?)`
			)
			.run(
				USER,
				USER,
				PROJECT,
				JSON.stringify({ workflow_state_id: STAGE_B }),
				NOW - HOUR,
				USER,
				USER,
				other,
				JSON.stringify({ workflow_state_id: STAGE_A }),
				NOW - 2 * HOUR
			);

		const report = await loadStageStats(t.db, USER, { project: 'demo' }, NOW);
		expect(report.markers).toHaveLength(1);
		expect(report.markers[0]).toMatchObject({
			id: 'evt_rule_mine',
			label: 'Stage routing rule changed',
			state_ids: [STAGE_B]
		});
		expect(report.markers[0].effects.map((effect) => effect.state_id)).toEqual([STAGE_B]);
	});

	it('orders equal-time marker seeds by id before forward batching', async () => {
		const t = setup();
		for (const id of ['evt_marker_z', 'evt_marker_a'])
			t.sqlite
				.prepare(
					`INSERT INTO event (id,user_id,type,actor_user_id,payload,created_at)
					 VALUES (?,?,'settings.updated',?,?,?)`
				)
				.run(id, USER, USER, JSON.stringify({ changed: ['quota'] }), NOW - HOUR);
		const report = await loadStageStats(t.db, USER, {}, NOW);
		expect(report.markers).toHaveLength(1);
		expect(report.markers[0].id).toBe('evt_marker_a');
		expect(report.markers[0].event_ids).toEqual(['evt_marker_a', 'evt_marker_z']);
	});

	it('prepares once and evaluates only marker-affected states', async () => {
		const t = setup();
		const issue = addIssue(t, { id: 'iss_observed', state: STAGE_B, workflow: 'wf_two' });
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - DAY,
			from: STAGE_A,
			to: STAGE_B
		});
		for (let index = 0; index < 20; index++)
			t.sqlite
				.prepare(
					`INSERT INTO event (id,user_id,type,actor_user_id,project_id,payload,created_at)
					 VALUES (?,?,'routing_rule.updated',?,?,?,?)`
				)
				.run(
					`evt_observed_${index}`,
					USER,
					USER,
					PROJECT,
					JSON.stringify({ workflow_state_id: STAGE_B }),
					NOW - (index + 1) * 4 * HOUR
				);
		const evaluated: string[] = [];
		const report = await loadStageStats(t.db, USER, {}, NOW, {
			evaluatedState: (stateId) => evaluated.push(stateId)
		});
		expect(statsCalls.preparations).toBe(1);
		expect(report.markers).toHaveLength(20);
		expect(evaluated).toEqual(Array(40).fill(STAGE_B));

		statsCalls.preparations = 0;
		const baseline = await loadStageStats(t.db, USER, {}, NOW, {
			profileRepeatPreparation: true
		});
		expect(statsCalls.preparations).toBe(41);
		expect(baseline).toEqual(report);
	});

	it('uses unordered type/time event reads backed by the migration index', async () => {
		const t = setup();
		const queries = t.spyOnQueries();
		await loadStageStats(t.db, USER, {}, NOW);
		const eventReads = queries().filter((query) => /from "event"/i.test(query));
		expect(eventReads.filter((query) => /"event"\."type" in/i.test(query)).length).toBeGreaterThan(
			0
		);
		for (const query of eventReads.filter((query) => /"event"\."type" in/i.test(query)))
			expect(query).not.toMatch(/order by/i);
		const plan = t.all(
			`EXPLAIN QUERY PLAN SELECT id FROM event INDEXED BY event_user_type_created_idx
			 WHERE user_id=? AND type IN ('issue.created','issue.transitioned')
			 AND created_at>=? AND created_at<?`,
			USER,
			NOW - 14 * DAY,
			NOW
		);
		expect(plan.map((row) => String(row.detail)).join('\n')).toContain(
			'event_user_type_created_idx'
		);
	});
});

describe('loadSentBackDrilldown', () => {
	it('chunks large issue sets and ignores comments after the newest transition', async () => {
		const t = setup();
		for (let index = 0; index < 101; index++) {
			const issue = addIssue(t, {
				id: `iss_evidence_${index}`,
				state: STAGE_A,
				workflow: 'wf_two'
			});
			addComment(t, { issueId: issue, body: `before ${index}`, at: NOW - DAY - MIN });
			addTransitionEvent(t, {
				issueId: issue,
				apiKeyId: null,
				at: NOW - DAY,
				from: STAGE_B,
				to: STAGE_A
			});
			addComment(t, { issueId: issue, body: `after ${index}`, at: NOW - HOUR });
		}
		const detail = await loadSentBackDrilldown(t.db, USER, { state: STAGE_B }, NOW);
		expect(detail.items).toHaveLength(101);
		expect(detail.items.map((item) => item.comment?.excerpt)).toEqual(
			expect.arrayContaining(['before 0', 'before 100'])
		);
		expect(detail.items.some((item) => item.comment?.excerpt.startsWith('after'))).toBe(false);
	});

	it('names the transition comment and prompt version in force', async () => {
		const t = setup();
		const issue = addIssue(t, { id: 'iss_1', state: STAGE_A, workflow: 'wf_two' });
		addComment(t, {
			issueId: issue,
			body: 'Please address the review notes.',
			at: NOW - DAY - MIN
		});
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - DAY,
			from: STAGE_B,
			to: STAGE_A
		});
		t.sqlite.exec(`
			INSERT INTO context_item (id, user_id, kind, name, description, project_id, workflow_state_id,
				issue_id, label_id, body, repo_url, repo_branch, repo_dir, config, position, version, created_at, updated_at)
			VALUES ('ctx_prompt', '${USER}', 'prompt', 'instructions', '', NULL, '${STAGE_B}', NULL, NULL,
				'Review carefully.', NULL, NULL, NULL, NULL, 0, 3, ${NOW - 3 * DAY}, ${NOW});
			INSERT INTO event (id, user_id, type, actor_user_id, payload, created_at)
			VALUES
				('evt_prompt_2', '${USER}', 'context.updated', '${USER}', '{"context_id":"ctx_prompt","version":2}', ${NOW - 2 * DAY}),
				('evt_prompt_3', '${USER}', 'context.updated', '${USER}', '{"context_id":"ctx_prompt","version":3}', ${NOW - HOUR});
		`);

		const detail = await loadSentBackDrilldown(t.db, USER, { state: STAGE_B }, NOW);
		expect(detail.prompt).toMatchObject({ context_id: 'ctx_prompt', current_version: 3 });
		expect(detail.items).toHaveLength(1);
		expect(detail.items[0]).toMatchObject({
			prompt_version: 2,
			comment: { excerpt: 'Please address the review notes.' }
		});
	});

	it('keeps the prompt version across deletion and recreation', async () => {
		const t = setup();
		const issue = addIssue(t, { id: 'iss_old_prompt', state: STAGE_A, workflow: 'wf_two' });
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - 3 * DAY,
			from: STAGE_B,
			to: STAGE_A
		});
		t.sqlite.exec(`
			INSERT INTO context_item (id, user_id, kind, name, description, project_id, workflow_state_id,
				issue_id, label_id, body, repo_url, repo_branch, repo_dir, config, position, version, created_at, updated_at)
			VALUES ('ctx_new', '${USER}', 'prompt', 'instructions', '', NULL, '${STAGE_B}', NULL, NULL,
				'New prompt.', NULL, NULL, NULL, NULL, 0, 1, ${NOW - DAY}, ${NOW - DAY});
			INSERT INTO event (id, user_id, type, actor_user_id, payload, created_at) VALUES
				('evt_old_created', '${USER}', 'context.created', '${USER}',
				 '{"context_id":"ctx_old","kind":"prompt","name":"instructions","scope":{"workflow_state_id":"${STAGE_B}"}}', ${NOW - 6 * DAY}),
				('evt_old_v2', '${USER}', 'context.updated', '${USER}',
				 '{"context_id":"ctx_old","kind":"prompt","name":"instructions","version":2,"scope":{"workflow_state_id":"${STAGE_B}"}}', ${NOW - 4 * DAY}),
				('evt_old_deleted', '${USER}', 'context.deleted', '${USER}',
				 '{"context_id":"ctx_old","kind":"prompt","name":"instructions","scope":{"workflow_state_id":"${STAGE_B}"}}', ${NOW - 2 * DAY}),
				('evt_new_created', '${USER}', 'context.created', '${USER}',
				 '{"context_id":"ctx_new","kind":"prompt","name":"instructions","scope":{"workflow_state_id":"${STAGE_B}"}}', ${NOW - DAY});
		`);

		const detail = await loadSentBackDrilldown(t.db, USER, { state: STAGE_B }, NOW);
		expect(detail.prompt).toMatchObject({ context_id: 'ctx_new', current_version: 1 });
		expect(detail.items[0]).toMatchObject({ prompt_version: 2, prompt_context_id: 'ctx_old' });
		for (const at of [NOW - 2 * DAY, NOW - DAY])
			addTransitionEvent(t, { issueId: issue, apiKeyId: null, at, from: STAGE_B, to: STAGE_A });
		const lifecycle = await loadSentBackDrilldown(t.db, USER, { state: STAGE_B }, NOW);
		expect(
			lifecycle.items.map((item) => [
				item.transitioned_at,
				item.prompt_context_id,
				item.prompt_version
			])
		).toEqual([
			[NOW - DAY, 'ctx_new', 1],
			[NOW - 2 * DAY, null, null],
			[NOW - 3 * DAY, 'ctx_old', 2]
		]);
	});

	it('falls back to scope when scope_to is JSON null', async () => {
		const t = setup();
		const issue = addIssue(t, { id: 'iss_null_scope', state: STAGE_A, workflow: 'wf_two' });
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - DAY,
			from: STAGE_B,
			to: STAGE_A
		});
		t.sqlite
			.prepare(
				`INSERT INTO event (id,user_id,type,actor_user_id,payload,created_at) VALUES
				 ('evt_null_scope_created',?,'context.created',?,?,?),
				 ('evt_null_scope_updated',?,'context.updated',?,?,?)`
			)
			.run(
				USER,
				USER,
				JSON.stringify({
					context_id: 'ctx_null_scope',
					kind: 'prompt',
					name: 'instructions',
					scope_to: null,
					scope: { workflow_state_id: STAGE_B }
				}),
				NOW - 3 * DAY,
				USER,
				USER,
				JSON.stringify({ context_id: 'ctx_null_scope', version: 2 }),
				NOW - 2 * DAY
			);

		const detail = await loadSentBackDrilldown(t.db, USER, { state: STAGE_B }, NOW);
		expect(detail.items[0]).toMatchObject({
			prompt_context_id: 'ctx_null_scope',
			prompt_version: 2
		});
	});

	it('does not transfer unrelated prompt lifecycle generations', async () => {
		const t = setup();
		const issue = addIssue(t, { id: 'iss_prompt_filter', state: STAGE_A, workflow: 'wf_two' });
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - DAY,
			from: STAGE_B,
			to: STAGE_A
		});
		t.sqlite.exec(`
			INSERT INTO event (id,user_id,type,actor_user_id,payload,created_at) VALUES
			('evt_relevant_created','${USER}','context.created','${USER}',
			 '{"context_id":"ctx_relevant","kind":"prompt","name":"instructions","scope":{"workflow_state_id":"${STAGE_B}"}}',${NOW - 3 * DAY}),
			('evt_relevant_update','${USER}','context.updated','${USER}',
			 '{"context_id":"ctx_relevant","version":2}',${NOW - 2 * DAY}),
			('evt_unrelated_created','${USER}','context.created','${USER}',
			 '{"context_id":"ctx_unrelated","kind":"prompt","name":"instructions","scope":{"workflow_state_id":"${STAGE_A}"}}',${NOW - 3 * DAY}),
			('evt_unrelated_update','${USER}','context.updated','${USER}',
			 '{"context_id":"ctx_unrelated","version":99}',${NOW - 2 * DAY});
		`);
		const queryResults = t.spyOnQueryResults();
		const detail = await loadSentBackDrilldown(t.db, USER, { state: STAGE_B }, NOW);
		expect(detail.items[0]).toMatchObject({ prompt_context_id: 'ctx_relevant', prompt_version: 2 });
		const lifecycleRead = queryResults().find((query) =>
			/json_extract[\s\S]* in \(select /i.test(query.sql)
		);
		expect(lifecycleRead?.rows.map((row) => row.id)).toEqual([
			'evt_relevant_created',
			'evt_relevant_update'
		]);
	});
});

describe('frozen sent-back windows', () => {
	it('includes since and excludes until, preserving the default now', async () => {
		const t = setup();
		const issue = addIssue(t, { state: STAGE_A, workflow: 'wf_two' });
		const until = NOW - DAY;
		for (const at of [until - 7 * DAY - 1, until - 7 * DAY, until - 1, until, NOW - 1])
			addTransitionEvent(t, { issueId: issue, apiKeyId: null, at, from: STAGE_B, to: STAGE_A });
		const frozen = await loadSentBackDrilldown(t.db, USER, { state: STAGE_B, until }, NOW);
		expect(frozen.window).toEqual({ since: until - 7 * DAY, until });
		expect(frozen.items.map((i) => i.transitioned_at)).toEqual([until - 1, until - 7 * DAY]);
		expect(
			(await loadSentBackDrilldown(t.db, USER, { state: STAGE_B }, NOW)).items.map(
				(i) => i.transitioned_at
			)
		).toEqual([NOW - 1, until, until - 1]);
	});
	it.each([NaN, Infinity, -1, 1.2, NOW + 1])('rejects invalid until %s', async (until) => {
		const t = setup();
		await expect(
			loadSentBackDrilldown(t.db, USER, { state: STAGE_B, until }, NOW)
		).rejects.toMatchObject({ status: 422 });
	});
});

it('includes system workflow activity but excludes foreign private workflow metadata', async () => {
	const t = setup();
	const issue = addIssue(t);
	addTransitionEvent(t, { issueId: issue, apiKeyId: null, at: NOW - HOUR, from: REVIEW, to: OPEN });
	addRun(t, {
		issueId: issue,
		runnerId: 'rnr_1',
		stateAtStart: OPEN,
		status: 'running',
		createdAt: NOW - HOUR + MIN,
		startedAt: NOW - HOUR + MIN
	});
	const report = await loadStageStats(t.db, USER, {}, NOW);
	expect(report.states.find((s) => s.state_id === OPEN)?.current).toMatchObject({
		visits: 1,
		runs: { total: 1 }
	});
	t.sqlite.exec(
		`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('foreign', 'Other', 'other@test', 1, '2026', '2026')`
	);
	t.sqlite.exec(`UPDATE workflow SET user_id='foreign' WHERE id='wf_two'`);
	const privateIssue = addIssue(t, { state: STAGE_B, workflow: 'wf_two' });
	addTransitionEvent(t, {
		issueId: privateIssue,
		apiKeyId: null,
		at: NOW - HOUR,
		from: STAGE_A,
		to: STAGE_B
	});
	expect(
		(await loadStageStats(t.db, USER, {}, NOW)).states.some((s) => s.workflow_id === 'wf_two')
	).toBe(false);
});

it.each([false, true])(
	'keeps global, project and stage routing marker scopes distinct (reverse=%s)',
	async (reverse) => {
		const t = setup();
		const issue = addIssue(t, { state: STAGE_B, workflow: 'wf_two' });
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - HOUR * 3,
			from: STAGE_B,
			to: STAGE_A
		});
		addTransitionEvent(t, {
			issueId: issue,
			apiKeyId: null,
			at: NOW - HOUR * 2,
			from: STAGE_A,
			to: STAGE_B
		});
		const scopes = [
			{ state: null, project: null },
			{ state: null, project: PROJECT },
			{ state: STAGE_B, project: PROJECT }
		];
		if (reverse) scopes.reverse();
		scopes.forEach((scope, i) =>
			t.sqlite
				.prepare(
					`INSERT INTO event (id,user_id,type,actor_user_id,project_id,payload,created_at) VALUES (?,?,'routing_rule.updated',?,?,?,?)`
				)
				.run(
					`mixed_${i}`,
					USER,
					USER,
					scope.project,
					JSON.stringify({ workflow_state_id: scope.state }),
					NOW - HOUR + i * 10000
				)
		);
		const report = await loadStageStats(t.db, USER, { project: PROJECT }, NOW);
		expect(report.markers).toHaveLength(3);
		for (const scope of ['Global', 'Project']) {
			const marker = report.markers.find((m) => m.label === `${scope} routing rule changed`)!;
			expect(marker.state_ids).toEqual([]);
			expect(marker.effects.map((e) => e.state_id)).toEqual(
				expect.arrayContaining([STAGE_A, STAGE_B])
			);
		}
		expect(report.markers.find((m) => m.label === 'Stage routing rule changed')?.state_ids).toEqual(
			[STAGE_B]
		);
	}
);

it('preserves cross-stage prompt batches while keeping different project rule batches separate', async () => {
	const t = setup();
	const other = addOtherProject(t);
	const insert = (id: string, type: string, project: string | null, payload: unknown, at: number) =>
		t.sqlite
			.prepare(
				`INSERT INTO event (id,user_id,type,actor_user_id,project_id,payload,created_at) VALUES (?,?,?,?,?,?,?)`
			)
			.run(id, USER, type, USER, project, JSON.stringify(payload), at);
	for (const [i, state] of [STAGE_A, STAGE_B].entries())
		insert(
			`prompt_${i}`,
			'context.updated',
			null,
			{ kind: 'prompt', name: 'instructions', scope: { workflow_state_id: state } },
			NOW - HOUR * 2 + i * 10000
		);
	for (const [i, project] of [PROJECT, other].entries())
		insert(
			`project_rule_${i}`,
			'routing_rule.updated',
			project,
			{ workflow_state_id: null },
			NOW - HOUR + i * 10000
		);
	const report = await loadStageStats(t.db, USER, {}, NOW);
	const prompts = report.markers.filter((m) => m.kind === 'prompt');
	expect(prompts).toHaveLength(1);
	expect(prompts[0].state_ids).toEqual([STAGE_A, STAGE_B]);
	expect(prompts[0].event_ids).toEqual(['prompt_0', 'prompt_1']);
	expect(report.markers.filter((m) => m.kind === 'rule')).toHaveLength(2);
});
