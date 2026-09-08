import { describe, expect, it } from 'vitest';
import {
	bindRuns,
	bucketOutcome,
	buildVisits,
	computeStageStats,
	isSentBack,
	median,
	percentile,
	type StatsEvent,
	type StatsInput,
	type StatsRun,
	type StatsStateMeta
} from './stats';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_757_000_000_000;
const WINDOW = 7 * DAY;

// The Engineering workflow the PRD's figures come from.
const ENG: StatsStateMeta[] = [
	{
		id: 'st_backlog',
		name: 'Backlog',
		workflow_id: 'wf_eng',
		workflow_name: 'Engineering',
		category: 'backlog',
		position: 0
	},
	{
		id: 'st_disc',
		name: 'Discovering',
		workflow_id: 'wf_eng',
		workflow_name: 'Engineering',
		category: 'active',
		position: 1
	},
	{
		id: 'st_res',
		name: 'Research',
		workflow_id: 'wf_eng',
		workflow_name: 'Engineering',
		category: 'active',
		position: 2
	},
	{
		id: 'st_impl',
		name: 'Implementation',
		workflow_id: 'wf_eng',
		workflow_name: 'Engineering',
		category: 'active',
		position: 3
	},
	{
		id: 'st_rev',
		name: 'Automated Review',
		workflow_id: 'wf_eng',
		workflow_name: 'Engineering',
		category: 'active',
		position: 4
	},
	{
		id: 'st_human',
		name: 'Human Review',
		workflow_id: 'wf_eng',
		workflow_name: 'Engineering',
		category: 'awaiting_human',
		position: 5
	},
	{
		id: 'st_done',
		name: 'Done',
		workflow_id: 'wf_eng',
		workflow_name: 'Engineering',
		category: 'done',
		position: 6
	}
];

let seq = 0;
function ev(p: Partial<StatsEvent> & { issue_id: string; created_at: number }): StatsEvent {
	seq++;
	return {
		id: `ev_${String(seq).padStart(5, '0')}`,
		type: 'issue.transitioned',
		actor_api_key_id: null,
		actor_is_run: false,
		from_state_id: null,
		to_state_id: null,
		...p
	};
}

function run(
	p: Partial<StatsRun> & { issue_id: string; state_id_at_start: string; created_at: number }
): StatsRun {
	seq++;
	return {
		id: `run_${seq}`,
		runner_id: 'rnr_1',
		runner_name: 'macbook-claude',
		status: 'completed',
		outcome: 'advanced',
		api_key_id: null,
		started_at: p.created_at + MIN,
		ended_at: p.created_at + 10 * MIN,
		...p
	};
}

function input(over: Partial<StatsInput> = {}): StatsInput {
	return {
		now: NOW,
		windowMs: WINDOW,
		compare: true,
		states: ENG,
		events: [],
		runs: [],
		advancedByKey: new Set(),
		outcomeRecordedSince: NOW - 30 * DAY,
		project: null,
		...over
	};
}

const stateMap = new Map(ENG.map((s) => [s.id, s]));

describe('percentile', () => {
	it('is nearest-rank and handles the edges', () => {
		expect(percentile([], 90)).toBeNull();
		expect(percentile([5], 90)).toBe(5);
		expect(median([1, 2, 3, 4])).toBe(2);
		// 10 samples: p90 is the 9th.
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
		expect(percentile([3, 1, 2], 100)).toBe(3);
	});
});

describe('isSentBack', () => {
	it('is an earlier, non-done target in the same workflow', () => {
		expect(isSentBack('st_rev', 'st_impl', stateMap)).toBe(true);
		expect(isSentBack('st_impl', 'st_rev', stateMap)).toBe(false);
		// Done sits last anyway, but the category rule is what holds a
		// "cancel" state placed early from reading as rework.
		expect(
			isSentBack(
				'st_rev',
				'st_cancel',
				new Map([
					...stateMap,
					[
						'st_cancel',
						{
							id: 'st_cancel',
							name: 'Canceled',
							workflow_id: 'wf_eng',
							workflow_name: 'Engineering',
							category: 'done' as const,
							position: 0
						}
					]
				])
			)
		).toBe(false);
		expect(isSentBack('st_rev', 'st_other_wf', stateMap)).toBe(false);
		expect(isSentBack('st_rev', null, stateMap)).toBe(false);
	});
});

describe('computeStageStats — the PRD figures', () => {
	it('reports Automated Review sending 11 of 55 exits back to Implementation, all by agents', () => {
		const events: StatsEvent[] = [];
		const entered = NOW - 3 * DAY;
		for (let i = 0; i < 55; i++) {
			const issue = `iss_${i}`;
			events.push(
				ev({
					issue_id: issue,
					created_at: entered,
					to_state_id: 'st_rev',
					from_state_id: 'st_impl'
				})
			);
			// The first 11 go back to Implementation, each by a run key.
			const back = i < 11;
			events.push(
				ev({
					issue_id: issue,
					created_at: entered + HOUR,
					from_state_id: 'st_rev',
					to_state_id: back ? 'st_impl' : 'st_human',
					actor_api_key_id: `key_${i}`,
					actor_is_run: back
				})
			);
		}
		const report = computeStageStats(input({ events }));
		const review = report.states.find((s) => s.state_id === 'st_rev');
		expect(review).toBeDefined();
		expect(review?.current.exits).toBe(55);
		expect(review?.current.sent_back).toMatchObject({ count: 11, agent: 11, human: 0 });
		expect(review?.current.sent_back.share).toBeCloseTo(11 / 55, 10);
		expect(review?.current.sent_back.by_target).toEqual([
			{ state_id: 'st_impl', state_name: 'Implementation', count: 11, agent: 11, human: 0 }
		]);
		// The mirror lands on the receiving stage.
		expect(report.states.find((s) => s.state_id === 'st_impl')?.current.received_back).toBe(11);
	});

	it('reports Discovering 20 runs over 6 issues with 11 launch failures', () => {
		const events: StatsEvent[] = [];
		const runs: StatsRun[] = [];
		const entered = NOW - 2 * DAY;
		for (let i = 0; i < 6; i++) {
			const issue = `iss_d${i}`;
			events.push(
				ev({ issue_id: issue, created_at: entered, to_state_id: 'st_disc', type: 'issue.created' })
			);
		}
		// 11 launch failures (status failed, never started) and 9 that ran.
		for (let i = 0; i < 20; i++) {
			const issue = `iss_d${i % 6}`;
			const failed = i < 11;
			runs.push(
				run({
					issue_id: issue,
					state_id_at_start: 'st_disc',
					created_at: entered + i * MIN,
					status: failed ? 'failed' : 'completed',
					outcome: failed ? null : 'stalled',
					started_at: failed ? null : entered + i * MIN + MIN,
					ended_at: entered + i * MIN + 2 * MIN
				})
			);
		}
		const report = computeStageStats(input({ events, runs }));
		const disc = report.states.find((s) => s.state_id === 'st_disc');
		expect(disc?.current.visits).toBe(6);
		expect(disc?.current.runs.total).toBe(20);
		expect(disc?.current.runs.outcomes.failed).toBe(11);
		expect(disc?.current.runs.outcomes.stalled).toBe(9);
		expect(disc?.current.runs.per_visit).toBeCloseTo(20 / 6, 10);
		expect(disc?.current.runs.top_runner).toEqual({
			id: 'rnr_1',
			name: 'macbook-claude',
			runs: 20
		});
	});

	it('reports a Research queue-wait p90 of 723 minutes', () => {
		// Ten visits whose waits make the nearest-rank p90 (the 9th) 723 min.
		const waits = [5, 12, 30, 44, 60, 90, 180, 400, 723, 900].map((m) => m * MIN);
		const events: StatsEvent[] = [];
		const runs: StatsRun[] = [];
		const entered = NOW - 4 * DAY;
		waits.forEach((wait, i) => {
			const issue = `iss_r${i}`;
			events.push(
				ev({
					issue_id: issue,
					created_at: entered,
					to_state_id: 'st_res',
					from_state_id: 'st_disc'
				})
			);
			runs.push(
				run({
					issue_id: issue,
					state_id_at_start: 'st_res',
					created_at: entered,
					started_at: entered + wait
				})
			);
		});
		const res = computeStageStats(input({ events, runs })).states.find(
			(s) => s.state_id === 'st_res'
		);
		expect(res?.current.queue_wait?.p90).toBe(723 * MIN);
		expect(res?.current.queue_wait?.p50).toBe(60 * MIN);
		expect(res?.current.queue_wait_measured).toBe(10);
	});
});

describe('computeStageStats — definitions', () => {
	it('excludes human stages and states that saw nothing', () => {
		const report = computeStageStats(
			input({
				events: [
					ev({
						issue_id: 'i1',
						created_at: NOW - DAY,
						to_state_id: 'st_human',
						from_state_id: 'st_rev'
					})
				]
			})
		);
		expect(report.states.map((s) => s.state_id)).toEqual(['st_rev']);
	});

	it('counts an issue.created entry and leaves the visit open', () => {
		const report = computeStageStats(
			input({
				events: [
					ev({
						issue_id: 'i1',
						created_at: NOW - DAY,
						to_state_id: 'st_disc',
						type: 'issue.created'
					})
				]
			})
		);
		const disc = report.states[0];
		expect(disc.current.visits).toBe(1);
		expect(disc.current.exits).toBe(0);
		expect(disc.current.waiting_now).toBe(1);
		expect(disc.current.queue_wait).toBeNull();
	});

	it('counts an unbounded visit’s exit but none of its durations', () => {
		// The entry predates the scan: only the exit event is in the events.
		const report = computeStageStats(
			input({
				events: [
					ev({
						issue_id: 'i1',
						created_at: NOW - DAY,
						from_state_id: 'st_rev',
						to_state_id: 'st_impl'
					})
				]
			})
		);
		const review = report.states.find((s) => s.state_id === 'st_rev');
		expect(review?.current.visits).toBe(0);
		expect(review?.current.exits).toBe(1);
		expect(review?.current.sent_back.count).toBe(1);
		expect(review?.current.queue_wait).toBeNull();
	});

	it('binds runs to the visit that contains them across a re-entry', () => {
		const t = NOW - 5 * DAY;
		const events = [
			ev({ issue_id: 'i1', created_at: t, to_state_id: 'st_impl', from_state_id: 'st_disc' }),
			ev({
				issue_id: 'i1',
				created_at: t + 2 * HOUR,
				from_state_id: 'st_impl',
				to_state_id: 'st_rev'
			}),
			ev({
				issue_id: 'i1',
				created_at: t + 3 * HOUR,
				from_state_id: 'st_rev',
				to_state_id: 'st_impl'
			}),
			ev({
				issue_id: 'i1',
				created_at: t + 6 * HOUR,
				from_state_id: 'st_impl',
				to_state_id: 'st_rev'
			})
		];
		const runs = [
			run({ issue_id: 'i1', state_id_at_start: 'st_impl', created_at: t + HOUR }),
			run({ issue_id: 'i1', state_id_at_start: 'st_impl', created_at: t + 4 * HOUR }),
			run({ issue_id: 'i1', state_id_at_start: 'st_impl', created_at: t + 5 * HOUR })
		];
		const visits = buildVisits(events, stateMap);
		const { bound, unbound } = bindRuns(visits, runs);
		expect(unbound).toEqual([]);
		expect([...bound.values()].map((rs) => rs.length).sort()).toEqual([1, 2]);
		const impl = computeStageStats(input({ events, runs })).states.find(
			(s) => s.state_id === 'st_impl'
		);
		// Two visits, both with runs: 3 runs over 2 visits.
		expect(impl?.current.visits).toBe(2);
		expect(impl?.current.runs.per_visit).toBeCloseTo(1.5, 10);
	});

	it('includes visits with no runs in the runs-per-visit denominator', () => {
		const entered = NOW - DAY;
		const events = Array.from({ length: 10 }, (_, i) =>
			ev({
				issue_id: `queued_${i}`,
				created_at: entered,
				from_state_id: 'st_disc',
				to_state_id: 'st_impl'
			})
		);
		const runs = Array.from({ length: 3 }, (_, i) =>
			run({ issue_id: `queued_${i}`, state_id_at_start: 'st_impl', created_at: entered + MIN })
		);
		const impl = computeStageStats(input({ events, runs })).states.find(
			(stage) => stage.state_id === 'st_impl'
		);
		expect(impl?.current.visits).toBe(10);
		expect(impl?.current.runs.total).toBe(3);
		expect(impl?.current.runs.per_visit).toBeCloseTo(0.3, 10);
	});

	it('does not let a launch failure end the queue wait', () => {
		const t = NOW - DAY;
		const events = [
			ev({ issue_id: 'i1', created_at: t, to_state_id: 'st_impl', from_state_id: 'st_disc' })
		];
		const runs = [
			run({
				issue_id: 'i1',
				state_id_at_start: 'st_impl',
				created_at: t + MIN,
				status: 'failed',
				outcome: null,
				started_at: null
			}),
			run({
				issue_id: 'i1',
				state_id_at_start: 'st_impl',
				created_at: t + 30 * MIN,
				started_at: t + 40 * MIN
			})
		];
		const impl = computeStageStats(input({ events, runs })).states[0];
		expect(impl.current.queue_wait?.p50).toBe(40 * MIN);
		expect(impl.current.runs.outcomes.failed).toBe(1);
	});

	it('counts a run for an unknown visit as unbound, never per-visit', () => {
		const runs = [run({ issue_id: 'gone', state_id_at_start: 'st_impl', created_at: NOW - DAY })];
		const impl = computeStageStats(input({ runs })).states[0];
		expect(impl.current.runs.unbound).toBe(1);
		expect(impl.current.runs.total).toBe(0);
		expect(impl.current.runs.per_visit).toBeNull();
	});

	it('recovers advanced for a pre-0016 run whose key authored a transition', () => {
		const stale = run({
			issue_id: 'i1',
			state_id_at_start: 'st_impl',
			created_at: NOW - DAY,
			outcome: null,
			api_key_id: 'key_1'
		});
		expect(bucketOutcome(stale, new Set())).toBe('unrecorded');
		expect(bucketOutcome(stale, new Set(['key_1']))).toBe('advanced');
		expect(bucketOutcome({ ...stale, status: 'running' }, new Set())).toBe('active');
		const t = NOW - DAY;
		const events = [
			ev({ issue_id: 'i1', created_at: t, to_state_id: 'st_impl', from_state_id: 'st_disc' })
		];
		const impl = computeStageStats(
			input({
				events,
				runs: [{ ...stale, created_at: t + MIN }],
				advancedByKey: new Set(['key_1'])
			})
		).states[0];
		expect(impl.current.runs.outcomes.advanced).toBe(1);
		expect(impl.current.runs.recovered_advanced).toBe(1);
	});

	it('splits the previous window and reports deltas, or none when compare is off', () => {
		const events: StatsEvent[] = [];
		// 3 exits this window, 1 sent back; 2 exits last window, 2 sent back.
		for (let i = 0; i < 3; i++) {
			events.push(
				ev({
					issue_id: `now_${i}`,
					created_at: NOW - 3 * DAY,
					to_state_id: 'st_rev',
					from_state_id: 'st_impl'
				})
			);
			events.push(
				ev({
					issue_id: `now_${i}`,
					created_at: NOW - 2 * DAY,
					from_state_id: 'st_rev',
					to_state_id: i === 0 ? 'st_impl' : 'st_human'
				})
			);
		}
		for (let i = 0; i < 2; i++) {
			events.push(
				ev({
					issue_id: `then_${i}`,
					created_at: NOW - 11 * DAY,
					to_state_id: 'st_rev',
					from_state_id: 'st_impl'
				})
			);
			events.push(
				ev({
					issue_id: `then_${i}`,
					created_at: NOW - 10 * DAY,
					from_state_id: 'st_rev',
					to_state_id: 'st_impl'
				})
			);
		}
		const review = computeStageStats(input({ events })).states.find((s) => s.state_id === 'st_rev');
		expect(review?.current.sent_back.share).toBeCloseTo(1 / 3, 10);
		expect(review?.previous?.sent_back.share).toBe(1);
		expect(review?.delta.sent_back_share).toBeCloseTo(1 / 3 - 1, 10);
		expect(review?.delta.exits).toBe(1);

		const nocompare = computeStageStats(input({ events, compare: false })).states.find(
			(s) => s.state_id === 'st_rev'
		);
		expect(nocompare?.previous).toBeNull();
		expect(nocompare?.delta.exits).toBeNull();
		expect(nocompare?.delta.outcomes.advanced).toBeNull();
	});

	it('orders rows by total queue wait, worst first', () => {
		const t = NOW - 2 * DAY;
		const events: StatsEvent[] = [];
		const runs: StatsRun[] = [];
		for (const [state, wait] of [
			['st_impl', 4 * HOUR],
			['st_res', 30 * HOUR],
			['st_rev', 10 * HOUR]
		] as const) {
			const issue = `i_${state}`;
			events.push(
				ev({ issue_id: issue, created_at: t, to_state_id: state, from_state_id: 'st_backlog' })
			);
			runs.push(
				run({ issue_id: issue, state_id_at_start: state, created_at: t, started_at: t + wait })
			);
		}
		expect(computeStageStats(input({ events, runs })).states.map((s) => s.state_id)).toEqual([
			'st_res',
			'st_rev',
			'st_impl'
		]);
	});
});
