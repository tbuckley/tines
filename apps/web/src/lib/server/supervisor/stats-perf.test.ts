import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
	evaluatePreparedState,
	prepareStageStats,
	type StatsEvent,
	type StatsInput,
	type StatsRun,
	type StatsStateMeta
} from './stats';

const DAY = 86_400_000;
const NOW = 1_789_344_000_000;

function fixture(): StatsInput {
	const states: StatsStateMeta[] = Array.from({ length: 28 }, (_, index) => ({
		id: `state_${index}`,
		name: `Stage ${index}`,
		workflow_id: 'workflow_scale',
		workflow_name: 'Scale workflow',
		category: 'active',
		position: index
	}));
	const events: StatsEvent[] = [];
	for (let index = 0; index < 524; index++) {
		const state = index % states.length;
		const entered = NOW - 13 * DAY + index * 1_000_000;
		events.push({
			id: `event_${index}_entry`,
			type: 'issue.created',
			issue_id: `issue_${index}`,
			created_at: entered,
			actor_api_key_id: null,
			actor_is_run: false,
			from_state_id: null,
			to_state_id: states[state].id
		});
		for (let move = 1; move < 5 && events.length < 2_440; move++) {
			events.push({
				id: `event_${index}_${move}`,
				type: 'issue.transitioned',
				issue_id: `issue_${index}`,
				created_at: entered + move * 3_600_000,
				actor_api_key_id: null,
				actor_is_run: false,
				from_state_id: states[(state + move - 1) % states.length].id,
				to_state_id: states[(state + move) % states.length].id
			});
		}
	}
	events.length = 2_440;
	const runs: StatsRun[] = Array.from({ length: 1_525 }, (_, index) => ({
		id: `run_${index}`,
		issue_id: `issue_${index % 524}`,
		runner_id: `runner_${index % 8}`,
		runner_name: `Runner ${index % 8}`,
		status: 'completed',
		outcome: 'advanced',
		state_id_at_start: states[index % states.length].id,
		api_key_id: null,
		created_at: NOW - 6 * DAY + index * 100_000,
		started_at: NOW - 6 * DAY + index * 100_000 + 30_000,
		ended_at: NOW - 6 * DAY + index * 100_000 + 90_000
	}));
	return {
		now: NOW,
		windowMs: 7 * DAY,
		compare: true,
		states,
		events,
		runs,
		advancedByKey: new Set(),
		outcomeRecordedSince: NOW - 30 * DAY,
		project: null
	};
}

describe('production-shaped prepared stats profile', () => {
	it('reports repeated preparation versus one shared preparation', () => {
		const input = fixture();
		const bounds = Array.from({ length: 40 }, (_, index) => ({
			since: NOW - 7 * DAY + index * 3_600_000,
			until: NOW - index * 3_600_000
		}));
		const run = (shared: boolean) => {
			const started = performance.now();
			const prepared = shared ? prepareStageStats(input) : null;
			let checksum = 0;
			for (const bound of bounds) {
				const index = prepared ?? prepareStageStats(input);
				for (const state of input.states) {
					checksum += evaluatePreparedState(index, state.id, bound.since, bound.until)?.visits ?? 0;
				}
			}
			return { ms: performance.now() - started, checksum };
		};
		const repeated = run(false);
		const shared = run(true);
		expect(shared.checksum).toBe(repeated.checksum);
		process.stdout.write(
			`stats scale (524 issues, ${input.events.length} events, 1525 runs, 40 windows): ` +
				`repeated preparation ${repeated.ms.toFixed(1)}ms; shared preparation ${shared.ms.toFixed(1)}ms\n`
		);
	});
});
