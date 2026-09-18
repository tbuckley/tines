/**
 * The first-run checklist, derived rather than stored. While an account has
 * never had an agent run, the Agents tab and an issue's agent-activity card
 * both show the same six items; each ticks from data the surface already
 * loads, so the list is order-agnostic and self-healing. Once a run exists the
 * checklist retires account-wide — there is no dismissal and nothing persisted.
 */
import type { AgentRun, RoutingRule, Runner } from '@tines/shared';

export type FirstRunItemId = 'issue' | 'cli' | 'runner' | 'rule' | 'enabled' | 'run';

/** The issue the "give it something to work with" item is about. */
export interface FirstRunIssue {
	project_name: string;
	number: number;
	title: string;
	has_description: boolean;
	/** Effective context: a repo item covering this issue at any scope. */
	has_repo: boolean;
}

export interface FirstRunInputs {
	/** Which surface is asking — the two differ in controls, not in ticks. */
	surface: 'agents' | 'issue';
	/** Account-level; always true on the issue surface (you are looking at one). */
	hasAnyIssue: boolean;
	/** Agents surface only: with no project, item 1 offers "Create a project". */
	hasAnyProject: boolean;
	runners: Runner[];
	rules: RoutingRule[];
	enabled: boolean;
	/** The page's issue, or the newest issue on the Agents tab; null = none yet. */
	issue: FirstRunIssue | null;
	/** The run that lands in the last item, once one exists. */
	firstRun: AgentRun | null;
	/** A run exists somewhere on the account but not on this issue. */
	runElsewhere?: boolean;
}

export interface FirstRunItem {
	id: FirstRunItemId;
	done: boolean;
	/** Greyed: waiting on an earlier item, so its control would go nowhere useful. */
	blocked: boolean;
}

/** Any runner at all, local or managed: a managed-only user never installs the CLI. */
function hasRunner(i: FirstRunInputs): boolean {
	return i.runners.length > 0;
}

/**
 * "A rule covers the runner" — any scope, any target that still exists.
 * Deliberately looser than the dispatch check, which also fails for ties and
 * pins: the checklist is about having wired routing at all.
 */
function hasCoveringRule(i: FirstRunInputs): boolean {
	return i.rules.some((rule) =>
		rule.targets.some((t) => i.runners.some((runner) => runner.id === t.runner_id))
	);
}

export function checklistItems(i: FirstRunInputs): FirstRunItem[] {
	const issueDone = i.surface === 'issue' || i.hasAnyIssue;
	const runner = hasRunner(i);
	const cli = runner;
	const rule = hasCoveringRule(i);
	const run = i.firstRun !== null || i.runElsewhere === true;
	return [
		{ id: 'issue', done: issueDone, blocked: false },
		{ id: 'cli', done: cli, blocked: false },
		{ id: 'runner', done: runner, blocked: false },
		{ id: 'rule', done: rule, blocked: !cli },
		{ id: 'enabled', done: i.enabled, blocked: false },
		{
			id: 'run',
			done: run,
			blocked: !run && !(issueDone && runner && rule && i.enabled)
		}
	];
}

/**
 * The single step whose control should be offered now. CLI installation is
 * supporting copy for adding a runner, and the run row has no setup control,
 * so neither becomes the current action independently.
 */
export function checklistCurrentAction(items: FirstRunItem[]): FirstRunItemId | null {
	// A saved stop always exposes Resume first; enabled accounts then follow
	// the ordinary issue → runner → explicit-routing setup path.
	const actionOrder: FirstRunItemId[] = ['enabled', 'issue', 'runner', 'rule'];
	return (
		actionOrder.find((id) => {
			const item = items.find((candidate) => candidate.id === id);
			return item != null && !item.done && !item.blocked;
		}) ?? null
	);
}

/**
 * Progress for the fold summary ("first run · 3 of 6"). Optional content
 * guidance is deliberately outside this count.
 */
export function checklistProgress(items: FirstRunItem[]): { done: number; total: number } {
	return { done: items.filter((item) => item.done).length, total: items.length };
}

/** Whether the repo hint shows: optional, and only while the issue has none. */
export function showRepoHint(i: FirstRunInputs): boolean {
	return i.surface === 'issue' && i.issue !== null && !i.issue.has_repo;
}
