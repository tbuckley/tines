import { describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './test-db';
import { loadStageStats, parseStatsWindow } from './supervisor';
import {
	addIssue,
	addRun,
	addRunKey,
	addRunner,
	addTransitionEvent,
	addTwoStageWorkflow,
	NOW,
	PROJECT,
	seedBase,
	STAGE_A,
	STAGE_B,
	USER
} from '$lib/server/supervisor/test-fixtures';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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
});
