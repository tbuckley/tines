import { describe, expect, it } from 'vitest';
import type { AgentRun, RoutingRule, Runner } from '@tines/shared';
import {
	checklistItems,
	checklistCurrentAction,
	checklistProgress,
	showRepoHint,
	type FirstRunInputs,
	type FirstRunItemId
} from './first-run';

function runner(over: Partial<Runner> = {}): Runner {
	return {
		id: 'rnr_1',
		type: 'local',
		name: 'laptop',
		status: 'active',
		online: true,
		...over
	} as Runner;
}

function rule(runnerIds: string[]): RoutingRule {
	return {
		id: 'rr_1',
		scope: { project_id: null, workflow_state_id: null, label_id: null },
		targets: runnerIds.map((id) => ({ runner_id: id })),
		created_at: 1,
		updated_at: 1
	} as RoutingRule;
}

function inputs(over: Partial<FirstRunInputs> = {}): FirstRunInputs {
	return {
		surface: 'agents',
		hasAnyIssue: false,
		hasAnyProject: false,
		runners: [],
		rules: [],
		enabled: true,
		issue: null,
		firstRun: null,
		...over
	};
}

function done(i: FirstRunInputs): FirstRunItemId[] {
	return checklistItems(i)
		.filter((item) => item.done)
		.map((item) => item.id);
}

describe('checklistItems', () => {
	it('defaults an empty account to ready and always renders six items', () => {
		const items = checklistItems(inputs());
		expect(items).toHaveLength(6);
		expect(items.filter((i) => i.done).map((i) => i.id)).toEqual(['enabled']);
	});

	it('ticks each item independently of the others (the list is order-agnostic)', () => {
		expect(done(inputs({ hasAnyIssue: true }))).toEqual(['issue', 'enabled']);
		expect(done(inputs({ enabled: true }))).toEqual(['enabled']);
		// A runner alone ticks both the CLI item and the runner item.
		expect(done(inputs({ runners: [runner()] }))).toEqual(['cli', 'runner', 'enabled']);
		// A rule ticks even though nothing before it is done, as long as its
		// target exists.
		expect(done(inputs({ runners: [runner()], rules: [rule(['rnr_1'])] }))).toEqual([
			'cli',
			'runner',
			'rule',
			'enabled'
		]);
	});

	it('treats the issue item as done on the issue surface whatever the account flag says', () => {
		expect(done(inputs({ surface: 'issue', hasAnyIssue: false }))).toEqual(['issue', 'enabled']);
	});

	it('ticks the CLI item for a managed-only account, which never installs it', () => {
		const managed = runner({ id: 'rnr_m', type: 'claude_managed', name: 'cloud' });
		expect(done(inputs({ runners: [managed] }))).toEqual(['cli', 'runner', 'enabled']);
	});

	it('ticks both setup items for any registered runner, regardless of its current status', () => {
		expect(done(inputs({ runners: [runner({ status: 'paused' })] }))).toEqual([
			'cli',
			'runner',
			'enabled'
		]);
		expect(done(inputs({ runners: [runner({ online: false })] }))).toEqual([
			'cli',
			'runner',
			'enabled'
		]);
	});

	it('does not tick the rule item when the rule targets a runner that is gone', () => {
		const i = inputs({ runners: [runner()], rules: [rule(['rnr_deleted'])] });
		expect(done(i)).toEqual(['cli', 'runner', 'enabled']);
	});

	it('ticks the rule item for a scoped rule, not just the global one', () => {
		const scoped = {
			...rule(['rnr_1']),
			scope: { project_id: 'prj_1', workflow_state_id: null, label_id: null }
		} as RoutingRule;
		expect(done(inputs({ runners: [runner()], rules: [scoped] }))).toContain('rule');
	});

	it('does not count optional issue content', () => {
		const issue = {
			project_name: 'demo',
			number: 1,
			title: 'First run',
			has_description: true,
			has_repo: false
		};
		expect(done(inputs({ surface: 'issue', issue }))).toEqual(['issue', 'enabled']);
		expect(done(inputs({ surface: 'issue', issue: { ...issue, has_description: false } }))).toEqual(
			['issue', 'enabled']
		);
		expect(checklistItems(inputs({ issue: null })).some((i) => i.id === ('content' as never))).toBe(
			false
		);
	});

	it('leaves the run item blocked until everything it needs is done', () => {
		const armed = inputs({
			hasAnyIssue: true,
			runners: [runner()],
			rules: [rule(['rnr_1'])],
			enabled: true
		});
		expect(checklistItems(inputs()).find((i) => i.id === 'run')!.blocked).toBe(true);
		expect(checklistItems(armed).find((i) => i.id === 'run')).toEqual({
			id: 'run',
			done: false,
			blocked: false
		});
	});

	it('ticks the run item for a run on this issue or elsewhere on the account', () => {
		const run = { id: 'run_1', runner_name: 'laptop', status: 'running' } as AgentRun;
		expect(done(inputs({ firstRun: run }))).toEqual(['enabled', 'run']);
		expect(done(inputs({ runElsewhere: true }))).toEqual(['enabled', 'run']);
	});

	it('unblocks the rule item as soon as a runner exists, even an offline one', () => {
		const byId = (i: FirstRunInputs) => checklistItems(i).find((it) => it.id === 'rule')!;
		expect(byId(inputs()).blocked).toBe(true);
		expect(byId(inputs({ runners: [runner({ online: false })] })).blocked).toBe(false);
	});
});

describe('checklistCurrentAction', () => {
	it('offers only the earliest incomplete actionable step', () => {
		expect(checklistCurrentAction(checklistItems(inputs()))).toBe('issue');
		expect(checklistCurrentAction(checklistItems(inputs({ hasAnyIssue: true })))).toBe('runner');
		expect(
			checklistCurrentAction(
				checklistItems(inputs({ hasAnyIssue: true, runners: [runner({ online: false })] }))
			)
		).toBe('rule');
	});

	it('returns no action when setup is complete even if optional content is absent', () => {
		const i = inputs({
			hasAnyIssue: true,
			runners: [runner()],
			rules: [rule(['rnr_1'])],
			enabled: true,
			issue: {
				project_name: 'demo',
				number: 1,
				title: 'First run',
				has_description: false,
				has_repo: false
			}
		});
		expect(checklistCurrentAction(checklistItems(i))).toBeNull();
	});

	it('offers resume before every setup action when explicitly stopped', () => {
		const i = inputs({
			hasAnyIssue: true,
			runners: [runner()],
			rules: [rule(['rnr_1'])],
			enabled: false,
			issue: {
				project_name: 'demo',
				number: 1,
				title: 'First run',
				has_description: false,
				has_repo: false
			}
		});
		expect(checklistCurrentAction(checklistItems(i))).toBe('enabled');
		expect(checklistCurrentAction(checklistItems(inputs({ enabled: false })))).toBe('enabled');
	});

	it('returns no action once only the run is outstanding', () => {
		const i = inputs({
			hasAnyIssue: true,
			runners: [runner()],
			rules: [rule(['rnr_1'])],
			enabled: true,
			issue: {
				project_name: 'demo',
				number: 1,
				title: 'First run',
				has_description: true,
				has_repo: true
			}
		});
		expect(checklistCurrentAction(checklistItems(i))).toBeNull();
	});
});

describe('checklistProgress', () => {
	it('counts the ticked items out of six', () => {
		expect(checklistProgress(checklistItems(inputs()))).toEqual({ done: 1, total: 6 });
		expect(
			checklistProgress(checklistItems(inputs({ hasAnyIssue: true, runners: [runner()] })))
		).toEqual({ done: 4, total: 6 });
	});
});

describe('showRepoHint', () => {
	const issue = {
		project_name: 'demo',
		number: 1,
		title: 'First run',
		has_description: true,
		has_repo: false
	};

	it('shows only on the issue surface, and only while the issue has no repo', () => {
		expect(showRepoHint(inputs({ surface: 'issue', issue }))).toBe(true);
		expect(showRepoHint(inputs({ surface: 'issue', issue: { ...issue, has_repo: true } }))).toBe(
			false
		);
		expect(showRepoHint(inputs({ surface: 'agents', issue }))).toBe(false);
	});

	it('never changes the count — the repo hint is optional', () => {
		const withHint = inputs({ surface: 'issue', issue });
		const without = inputs({ surface: 'issue', issue: { ...issue, has_repo: true } });
		expect(checklistProgress(checklistItems(withHint))).toEqual(
			checklistProgress(checklistItems(without))
		);
	});
});
