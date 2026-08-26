import { describe, expect, it } from 'vitest';
import { ApiFail } from './core';
import { planRunnerRemoval, requireTier, runnerOnline, type RunnerRemovalRefs } from './runners';

const runner = { id: 'rnr_1', name: 'laptop-m4' };

const noRefs: RunnerRemovalRefs = { activeRuns: 0, rules: [], pins: [] };
const refs: RunnerRemovalRefs = {
	activeRuns: 0,
	rules: [
		{
			id: 'rul_1',
			label: 'global',
			targets: [{ runner_id: 'rnr_1' }, { runner_id: 'rnr_2', tier: 'cheapest' }]
		},
		{ id: 'rul_2', label: 'project acme', targets: [{ runner_id: 'rnr_1', tier: 'smartest' }] }
	],
	pins: [{ issue_id: 'iss_1', project_id: 'prj_1', ref: 'demo/12' }]
};

describe('planRunnerRemoval', () => {
	it('removes an unreferenced runner without force', () => {
		expect(planRunnerRemoval(runner, noRefs, false)).toEqual({ ruleUpdates: [], pinClears: [] });
	});

	it('always refuses while runs are active — force is about references, not live work', () => {
		for (const force of [false, true]) {
			try {
				planRunnerRemoval(runner, { ...refs, activeRuns: 2 }, force);
				throw new Error('expected a 422');
			} catch (e) {
				expect(e).toBeInstanceOf(ApiFail);
				expect((e as ApiFail).code).toBe('runner_busy');
				expect((e as ApiFail).message).toContain('2 active runs');
			}
		}
	});

	it('rejects by default, naming the referencing rules and pins', () => {
		try {
			planRunnerRemoval(runner, refs, false);
			throw new Error('expected a 422');
		} catch (e) {
			expect(e).toBeInstanceOf(ApiFail);
			const fail = e as ApiFail;
			expect(fail.code).toBe('runner_referenced');
			expect(fail.message).toContain('project acme');
			expect(fail.message).toContain('demo/12');
			expect(fail.details).toMatchObject({
				rules: [
					{ rule_id: 'rul_1', label: 'global' },
					{ rule_id: 'rul_2', label: 'project acme' }
				],
				pins: [{ issue_id: 'iss_1', ref: 'demo/12' }]
			});
		}
	});

	it('force strips targets and clears pins, flagging (not deleting) emptied rules', () => {
		const plan = planRunnerRemoval(runner, refs, true);
		expect(plan.ruleUpdates).toEqual([
			{
				id: 'rul_1',
				label: 'global',
				targets: [{ runner_id: 'rnr_2', tier: 'cheapest' }],
				emptied: false
			},
			{ id: 'rul_2', label: 'project acme', targets: [], emptied: true }
		]);
		expect(plan.pinClears).toEqual(refs.pins);
	});
});

describe('requireTier', () => {
	it('accepts exactly the closed set', () => {
		expect(requireTier('smartest', 't')).toBe('smartest');
		expect(requireTier('balanced', 't')).toBe('balanced');
		expect(requireTier('cheapest', 't')).toBe('cheapest');
	});

	it('rejects anything else with the allowed set in the details', () => {
		try {
			requireTier('opus', 'pinned_tier');
			throw new Error('expected a 422');
		} catch (e) {
			expect(e).toBeInstanceOf(ApiFail);
			expect((e as ApiFail).code).toBe('unknown_tier');
			expect((e as ApiFail).details?.allowed_tiers).toEqual(['smartest', 'balanced', 'cheapest']);
		}
	});
});

describe('runnerOnline', () => {
	const now = 1_723_000_000_000;

	it('managed runners are always online', () => {
		expect(runnerOnline({ type: 'claude_managed', last_seen_at: null }, now)).toBe(true);
	});

	it('local runners are online only while the daemon polled within the window', () => {
		expect(runnerOnline({ type: 'local', last_seen_at: null }, now)).toBe(false);
		expect(runnerOnline({ type: 'local', last_seen_at: now - 60_000 }, now)).toBe(true);
		expect(runnerOnline({ type: 'local', last_seen_at: now - 3 * 60_000 }, now)).toBe(false);
	});
});
