import { describe, expect, it } from 'vitest';
import type { ActorRun, AgentRunUsage, StateCategory, Workflow } from './types.js';
import {
	actorLabel,
	activeStateIds,
	compareLabelNames,
	isActiveRun,
	isStaleTierOverride,
	runCostLabel,
	runDurationLabel,
	runRefLabel
} from './types.js';

describe('runCostLabel', () => {
	const label = (usage: AgentRunUsage | null) => runCostLabel({ usage });

	it('prefers dollars whenever a cost is known', () => {
		expect(label({ cost_usd: 1.2, cost_source: 'provider' })).toBe('$1.20 Reported');
		// tokens present too — dollars still win
		expect(label({ cost_usd: 0, input_tokens: 500, output_tokens: 10 })).toBe('$0 Recorded');
	});

	it('says so when the provider reports no cost at all', () => {
		expect(label({ cost_source: 'none', input_tokens: 10, output_tokens: 20 })).toBe('Unreported');
	});

	it('falls back to summed tokens when only they are known', () => {
		expect(label({ input_tokens: 1000, output_tokens: 2000 })).toBe('3,000 tok');
		expect(label({ output_tokens: 2000 })).toBe('2,000 tok');
		expect(
			label({
				input_tokens: 400,
				output_tokens: 100,
				cache_read_tokens: 600,
				cache_write_tokens: 50
			})
		).toBe('1,150 tok');
		expect(label({ cache_read_tokens: 600 })).toBe('600 tok');
	});

	it('keeps explicit legacy zero measurements visibly unpriced', () => {
		expect(label(null)).toBeNull();
		expect(label({})).toBeNull();
		expect(label({ input_tokens: 0, output_tokens: 0 })).toBe('Unpriced');
		expect(
			label({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 })
		).toBe('Unpriced');
	});
});

describe('isActiveRun', () => {
	it('is true for exactly the claim-holding statuses', () => {
		expect(isActiveRun('assigned')).toBe(true);
		expect(isActiveRun('launching')).toBe(true);
		expect(isActiveRun('running')).toBe(true);
	});

	it('is false once the run has settled', () => {
		for (const status of ['completed', 'failed', 'timed_out', 'canceled'] as const) {
			expect(isActiveRun(status)).toBe(false);
		}
	});
});

describe('activeStateIds', () => {
	const wf = (...states: [string, StateCategory][]): Pick<Workflow, 'states'> => ({
		states: states.map(([id, category], i) => ({
			id,
			name: id,
			category,
			position: i,
			inherits_from: null
		}))
	});

	it('collects active states across every workflow', () => {
		const ids = activeStateIds([
			wf(['a1', 'active'], ['b1', 'backlog']),
			wf(['a2', 'active'], ['d1', 'done'])
		]);
		expect([...ids].sort()).toEqual(['a1', 'a2']);
	});

	it('excludes every non-active category', () => {
		const ids = activeStateIds([wf(['b', 'backlog'], ['h', 'awaiting_human'], ['d', 'done'])]);
		expect(ids.size).toBe(0);
	});

	it('handles no workflows and stateless workflows', () => {
		expect(activeStateIds([]).size).toBe(0);
		expect(activeStateIds([wf()]).size).toBe(0);
	});
});

describe('runDurationLabel', () => {
	it('is the documented em-dash before launch', () => {
		expect(runDurationLabel({ started_at: null, ended_at: null })).toBe('—');
	});

	it('counts seconds under a minute and whole minutes above', () => {
		expect(runDurationLabel({ started_at: 1000, ended_at: 43_000 })).toBe('42s');
		expect(runDurationLabel({ started_at: 1000, ended_at: 1000 + 12 * 60_000 })).toBe('12m');
	});

	it('measures an unfinished run against now', () => {
		expect(runDurationLabel({ started_at: 5_000, ended_at: null }, 35_000)).toBe('30s');
	});
});

describe('isStaleTierOverride', () => {
	it('flags a predecessor of the current built-in', () => {
		expect(isStaleTierOverride('claude-fable-5-1', 'claude-fable-5')).toBe(true);
		expect(isStaleTierOverride('claude-fable-5-1', 'claude-opus-5')).toBe(true);
	});

	it('does not flag the built-in itself, unknown models, or missing values', () => {
		expect(isStaleTierOverride('claude-fable-5-1', 'claude-fable-5-1')).toBe(false);
		expect(isStaleTierOverride('claude-fable-5-1', 'some-custom-model')).toBe(false);
		expect(isStaleTierOverride(null, 'claude-fable-5')).toBe(false);
		expect(isStaleTierOverride('claude-fable-5-1', undefined)).toBe(false);
	});
});

describe('compareLabelNames', () => {
	it('folds ASCII case and leaves everything else in code-unit order', () => {
		expect(['zeta', 'éclair', 'Bug', 'apple'].sort(compareLabelNames)).toEqual([
			'apple',
			'Bug',
			'zeta',
			'éclair'
		]);
	});

	it('is a total order: antisymmetric, and equal on a pure case change', () => {
		const names = ['zeta', 'éclair', 'Bug', 'apple', 'bug'];
		for (const a of names) {
			for (const b of names) {
				expect(compareLabelNames(a, b) + compareLabelNames(b, a)).toBe(0);
			}
		}
		expect(compareLabelNames('Bug', 'bug')).toBe(0);
	});
});

describe('runRefLabel', () => {
	const run: ActorRun = {
		run_id: 'arun_9Xq2',
		runner_name: 'laptop-m4',
		issue_ref: { project_name: 'demo', number: 12 }
	};

	it('names the issue the run is working', () => {
		expect(runRefLabel(run)).toBe('run on demo/12');
	});

	it('falls back to the run id when the issue is gone', () => {
		expect(runRefLabel({ ...run, issue_ref: null })).toBe('run arun_9Xq2');
	});

	it('is the same phrase actorLabel uses for a run key', () => {
		const label = actorLabel({
			user_id: 'usr_1',
			user_name: 'alice',
			api_key_id: 'key_1',
			api_key_name: 'run arun_9Xq2',
			run
		});
		expect(label).toBe('alice via laptop-m4 · run on demo/12');
		expect(label.endsWith(runRefLabel(run))).toBe(true);
	});
});
