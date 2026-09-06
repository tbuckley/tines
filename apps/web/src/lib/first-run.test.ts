import { describe, expect, it } from 'vitest';
import type { AgentRun, RoutingRule, Runner } from '@tines/shared';
import {
	checklistItems,
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
		enabled: false,
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
	it('ticks nothing on an empty account and always renders seven items', () => {
		const items = checklistItems(inputs());
		expect(items).toHaveLength(7);
		expect(items.filter((i) => i.done)).toEqual([]);
	});

	it('ticks each item independently of the others (the list is order-agnostic)', () => {
		expect(done(inputs({ hasAnyIssue: true }))).toEqual(['issue']);
		expect(done(inputs({ enabled: true }))).toEqual(['enabled']);
		// A runner alone ticks both the CLI item and the runner item.
		expect(done(inputs({ runners: [runner()] }))).toEqual(['cli', 'runner']);
		// A rule ticks even though nothing before it is done, as long as its
		// target exists.
		expect(done(inputs({ runners: [runner()], rules: [rule(['rnr_1'])] }))).toEqual([
			'cli',
			'runner',
			'rule'
		]);
	});

	it('treats the issue item as done on the issue surface whatever the account flag says', () => {
		expect(done(inputs({ surface: 'issue', hasAnyIssue: false }))).toEqual(['issue']);
	});

	it('ticks the CLI item for a managed-only account, which never installs it', () => {
		const managed = runner({ id: 'rnr_m', type: 'claude_managed', name: 'cloud' });
		expect(done(inputs({ runners: [managed] }))).toEqual(['cli', 'runner']);
	});

	it('does not tick the runner item for a paused or offline runner, but the CLI item stands', () => {
		expect(done(inputs({ runners: [runner({ status: 'paused' })] }))).toEqual(['cli']);
		expect(done(inputs({ runners: [runner({ online: false })] }))).toEqual(['cli']);
	});

	it('does not tick the rule item when the rule targets a runner that is gone', () => {
		const i = inputs({ runners: [runner()], rules: [rule(['rnr_deleted'])] });
		expect(done(i)).toEqual(['cli', 'runner']);
	});

	it('ticks the rule item for a scoped rule, not just the global one', () => {
		const scoped = {
			...rule(['rnr_1']),
			scope: { project_id: 'prj_1', workflow_state_id: null, label_id: null }
		} as RoutingRule;
		expect(done(inputs({ runners: [runner()], rules: [scoped] }))).toContain('rule');
	});

	it('ticks the content item on a described issue and blocks it when there is none', () => {
		const issue = {
			project_name: 'demo',
			number: 1,
			title: 'First run',
			has_description: true,
			has_repo: false
		};
		expect(done(inputs({ surface: 'issue', issue }))).toEqual(['issue', 'content']);
		expect(done(inputs({ surface: 'issue', issue: { ...issue, has_description: false } }))).toEqual(
			['issue']
		);
		const blank = checklistItems(inputs({ issue: null })).find((i) => i.id === 'content')!;
		expect(blank.blocked).toBe(true);
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
		expect(done(inputs({ firstRun: run }))).toEqual(['run']);
		expect(done(inputs({ runElsewhere: true }))).toEqual(['run']);
	});

	it('unblocks the rule item as soon as a runner exists, even an offline one', () => {
		const byId = (i: FirstRunInputs) => checklistItems(i).find((it) => it.id === 'rule')!;
		expect(byId(inputs()).blocked).toBe(true);
		expect(byId(inputs({ runners: [runner({ online: false })] })).blocked).toBe(false);
	});
});

describe('checklistProgress', () => {
	it('counts the ticked items out of seven', () => {
		expect(checklistProgress(checklistItems(inputs()))).toEqual({ done: 0, total: 7 });
		expect(
			checklistProgress(checklistItems(inputs({ hasAnyIssue: true, runners: [runner()] })))
		).toEqual({ done: 3, total: 7 });
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
