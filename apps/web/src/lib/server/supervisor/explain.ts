/**
 * The dispatch explainer: "why isn't this running?" as data, shared by
 * `GET /api/v1/issues/:id/dispatch`, the CLI, and the issue page's agent
 * panel. Builds on the same logic the engine dispatches with, so the
 * explanation can never disagree with the behavior.
 *
 * Route-only (not worker-imported), so unlike engine.ts it may reach into
 * the api modules.
 */
import {
	ACTIVE_RUN_STATUSES,
	type AgentRun,
	type DispatchCheck,
	type DispatchCheckAction,
	type DispatchExplainer,
	type DispatchTarget,
	type Issue
} from '@tines/shared';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { archivedDate } from '$lib/server/api/archive';
import { issueQuery, serializeIssue } from '$lib/server/api/issues';
import { runQuery, serializeRun } from '$lib/server/api/runs';
import { scopeLabel } from '$lib/server/api/scope';
import {
	loadActiveCounts,
	loadDispatchSettings,
	loadEligibleIssues,
	loadEngineRules,
	loadEngineRunners,
	targetsForIssue
} from './engine';
import { isRoutedCandidate, resolveTier, speakingTarget, targetVerdict } from './logic';

export async function explainDispatch(
	db: Kysely<Database>,
	userId: string,
	issueId: string,
	now: number = Date.now(),
	/** The already-loaded issue, when the caller has it — skips the re-fetch. */
	preloaded?: Issue
): Promise<DispatchExplainer | null> {
	let issue = preloaded;
	if (!issue) {
		const row = await issueQuery(db, userId).where('issue.id', '=', issueId).executeTakeFirst();
		if (!row) return null;
		issue = serializeIssue(row);
	}

	const [settings, runners, rules, counts, activeRunRow] = await Promise.all([
		loadDispatchSettings(db, userId),
		loadEngineRunners(db, userId),
		loadEngineRules(db, userId),
		loadActiveCounts(db, userId),
		runQuery(db, userId)
			.where('agent_run.issue_id', '=', issueId)
			.where('agent_run.status', 'in', [...ACTIVE_RUN_STATUSES])
			.orderBy('agent_run.created_at desc')
			.executeTakeFirst()
	]);
	const activeRun: AgentRun | null = activeRunRow ? serializeRun(activeRunRow) : null;

	// The pin/rule resolution the pass would make for this issue right now.
	const candidateShape = {
		id: issue.id,
		project_id: issue.project_id,
		state_id: issue.state.id,
		updated_at: issue.updated_at,
		pinned_runner_id: issue.pinned_runner_id,
		pinned_tier: issue.pinned_tier,
		label_ids: issue.labels.map((l) => l.id)
	};
	const { targets, rule, runnerRule, tierOverride, ambiguous, failure, pinned } = targetsForIssue(
		candidateShape,
		rules
	);

	// The winner and, when two label rules tie, the rules that tied: both are
	// rendered by scope, so they share one name lookup.
	const described = await describeRules(
		db,
		[rule, runnerRule, ...ambiguous].filter((r): r is NonNullable<typeof r> => r !== null)
	);
	const describedById = new Map(described.map((item) => [item.rule_id, item]));
	const matchedRule: DispatchExplainer['matched_rule'] = rule ? describedById.get(rule.id)! : null;
	const runnerRuleDescription: DispatchExplainer['runner_rule'] = runnerRule
		? tierOverride
			? describedById.get(runnerRule.id)!
			: null
		: null;
	const ambiguousRules = ambiguous.map((item) => describedById.get(item.id)!);

	// The eligibility checks, in the order the engine applies them.
	const category = issue.effective_state.category;
	const notReadyDetail = issue.duplicate_of
		? `duplicate of ${issue.duplicate_of.project_name}/${issue.duplicate_of.number}`
		: issue.open_blockers.length > 0
			? `blocked by ${issue.open_blockers.map((b) => `${b.project_name}/${b.number}`).join(', ')}`
			: null;
	// Every remedy the explainer can offer names a control that already
	// exists: a page to open, or a command to paste. Nothing here is a
	// suggestion to write new code.
	const ref = `${issue.project_name}/${issue.number}`;
	const openIssue = (other: { project_name: string; number: number }): DispatchCheckAction => ({
		label: `Open ${other.project_name}/${other.number}`,
		href: `/issues/${other.project_name}/${other.number}`
	});
	const readyAction: DispatchCheckAction | undefined = issue.duplicate_of
		? openIssue(issue.duplicate_of)
		: issue.open_blockers.length > 0
			? openIssue(issue.open_blockers[0])
			: undefined;
	// The `routed` check is four failure modes in one, so its remedy is
	// chosen by the same branches that choose its detail.
	// A pin always yields one target, so a dead pin never fails this check —
	// its remedy is attached below, once the targets have been resolved.
	const routedAction: DispatchCheckAction | undefined =
		targets.length > 0
			? undefined
			: failure === 'ambiguous_rule'
				? { label: 'Make one rule more specific', href: '/agents#routing' }
				: failure === 'no_runner_rule'
					? { label: 'Configure routing', href: '/agents#routing' }
					: rule
						? {
								label: tierOverride && runnerRule ? 'Edit the runner rule' : 'Edit the rule',
								href: '/agents#routing'
							}
						: {
								label: 'Add a routing rule',
								href: '/agents#routing',
								cli: `tines routing set ${[...runners.values()][0]?.name ?? '<runner>'}`
							};
	const checks: DispatchCheck[] = [
		{
			name: 'automation_enabled',
			ok: settings.enabled,
			detail: settings.enabled ? 'automation is on' : 'the kill switch is off — nothing dispatches',
			...(settings.enabled
				? {}
				: {
						action: {
							label: 'Turn automation on',
							href: '/agents',
							cli: 'tines supervisor enable'
						}
					})
		},
		{
			name: 'project_archived',
			ok: issue.project_archived_at === null,
			detail:
				issue.project_archived_at === null
					? `project ${issue.project_name} is live`
					: `project ${issue.project_name} is archived (since ${archivedDate(issue.project_archived_at)}) — nothing dispatches`
		},
		{
			name: 'state_active',
			ok: category === 'active',
			detail: `state ${issue.effective_state.name} (${category})${category === 'active' ? '' : ' — agents only take on active states'}`
		},
		{
			name: 'ready',
			ok: notReadyDetail === null,
			detail: notReadyDetail ?? 'ready — not a duplicate, no open blockers',
			...(readyAction ? { action: readyAction } : {})
		},
		{
			name: 'no_active_run',
			ok: activeRun === null,
			detail: activeRun
				? `${activeRun.runner_name} holds the claim (run ${activeRun.status})`
				: 'no run holds the claim'
		},
		{
			name: 'not_parked',
			ok: !issue.needs_attention,
			detail: issue.needs_attention
				? `parked after ${issue.attempt_count} strike${issue.attempt_count === 1 ? '' : 's'} — resume to re-enter the pool`
				: `${issue.attempt_count} strike${issue.attempt_count === 1 ? '' : 's'} so far`,
			...(issue.needs_attention
				? { action: { label: 'Resume', cli: `tines issues resume ${ref}` } }
				: {})
		},
		{
			name: 'routed',
			ok: targets.length > 0,
			detail: pinned
				? `pinned to ${issue.pinned_runner_name ?? issue.pinned_runner_id}${issue.pinned_tier ? ` (tier ${issue.pinned_tier})` : ''} — replaces rule matching`
				: failure === 'ambiguous_rule'
					? `matches the ${ambiguousRules.map((r) => r.scope_label).join(' and ')} rules equally — neither is more specific; add a project or state to one of them`
					: rule && tierOverride && targets.length > 0
						? `Tier ${tierOverride} from ${matchedRule!.scope_label}; runners from ${runnerRuleDescription!.scope_label}`
						: failure === 'no_runner_rule'
							? `matched the ${matchedRule!.scope_label} tier override, but no broader routing rule supplies runners`
							: rule && tierOverride && runnerRule && failure === 'no_targets'
								? `matched the ${matchedRule!.scope_label} tier override, but the ${runnerRuleDescription!.scope_label} runner rule has no targets`
								: rule
									? targets.length > 0
										? `matched the ${matchedRule!.scope_label} rule`
										: `matched the ${matchedRule!.scope_label} rule, but it has no targets`
									: 'no matching routing rule — automation is opt-in via rules',
			...(routedAction ? { action: routedAction } : {})
		}
	];
	const eligible = checks.every((c) => c.ok);

	// Per-target verdicts in preference order, with tier→model resolution.
	const targetVerdicts: DispatchTarget[] = [];
	for (const target of targets) {
		const runner = runners.get(target.runner_id);
		if (!runner) continue;
		const resolved = resolveTier(runner, target.tier ?? null);
		const { verdict, detail } = targetVerdict(runner, counts, settings.quota, issue.state.id, now);
		targetVerdicts.push({
			runner_id: runner.id,
			runner_name: runner.name,
			tier: resolved.tier,
			model: resolved.model,
			verdict,
			detail
		});
	}
	const firstOk = targetVerdicts.find((t) => t.verdict === 'ok') ?? null;

	// A pin to a runner that has since been removed still counts as routed
	// (the engine would try it), but nothing can run: offer the way out.
	if (pinned && targetVerdicts.length === 0) {
		const routedCheck = checks.find((c) => c.name === 'routed')!;
		routedCheck.action = { label: 'Clear the pin', cli: `tines issues assign ${ref} --clear` };
	}

	// Queue position, only for eligible-but-waiting: among eligible issues
	// that would actually route somewhere, how many are ahead in the
	// oldest-`updated_at`-first queue.
	let queuePosition: number | null = null;
	if (eligible && !firstOk) {
		const eligibleIssues = await loadEligibleIssues(db, userId);
		const routed = eligibleIssues.filter((c) => isRoutedCandidate(c, rules));
		const index = routed.findIndex((c) => c.id === issue.id);
		queuePosition = index >= 0 ? index : null;
	}

	return {
		eligible,
		checks,
		pin: issue.pinned_runner_id
			? {
					runner_id: issue.pinned_runner_id,
					runner_name: issue.pinned_runner_name,
					tier: issue.pinned_tier
				}
			: null,
		matched_rule: matchedRule,
		runner_rule: runnerRuleDescription,
		tier_override: tierOverride,
		ambiguous_rules: ambiguousRules,
		targets: targetVerdicts,
		parked: issue.needs_attention,
		attempt_count: issue.attempt_count,
		attempt_limit: settings.attemptLimit,
		active_run: activeRun,
		queue_position: queuePosition,
		verdict: verdictLine({
			issue,
			settings,
			checks,
			targets: targetVerdicts,
			ambiguousRules,
			activeRun,
			queuePosition,
			routeFailure: failure
		})
	};
}

/** The one-line human verdict the issue page and CLI lead with. */
function verdictLine(input: {
	issue: Issue;
	settings: { enabled: boolean };
	checks: DispatchCheck[];
	targets: DispatchTarget[];
	ambiguousRules: { rule_id: string; scope_label: string }[];
	activeRun: AgentRun | null;
	queuePosition: number | null;
	routeFailure: 'no_rule' | 'ambiguous_rule' | 'no_runner_rule' | 'no_targets' | null;
}): string {
	const { issue, activeRun } = input;
	if (activeRun) {
		const verb =
			activeRun.status === 'running'
				? 'is working this issue'
				: activeRun.status === 'launching'
					? 'is launching on this issue'
					: 'is assigned to this issue';
		return `${activeRun.runner_name} ${verb}`;
	}
	if (!input.settings.enabled) return 'Automation is off';
	if (issue.needs_attention) {
		return `Parked — agents struck out ${issue.attempt_count} time${issue.attempt_count === 1 ? '' : 's'} here`;
	}
	if (issue.effective_state.category !== 'active') {
		return `Not eligible — state ${issue.effective_state.name} (${issue.effective_state.category})`;
	}
	const ready = input.checks.find((c) => c.name === 'ready');
	if (ready && !ready.ok) return `Not eligible — ${ready.detail}`;
	if (input.targets.length === 0) {
		if (input.ambiguousRules.length > 0) return 'Two routing rules tie — make one more specific';
		if (input.routeFailure === 'no_runner_rule')
			return 'No inherited runners — add or edit a broader routing rule';
		if (input.routeFailure === 'no_targets') return 'No effective targets — edit routing';
		return issue.pinned_runner_id
			? 'Pinned to a removed runner — clear the pin'
			: 'No matching routing rule — nothing will dispatch';
	}
	// The same target the fleet queue groups by (`speakingTarget`): the first
	// `ok` one, because that is where dispatch would send it, else the first.
	const first = speakingTarget(input.targets)!;
	if (first.verdict === 'ok') return `Eligible — would dispatch to ${first.runner_name} next pass`;
	const why =
		first.verdict === 'paused'
			? `${first.runner_name} is paused`
			: first.verdict === 'offline'
				? `${first.runner_name} is offline`
				: first.verdict === 'draining'
					? `${first.runner_name} is restarting to update`
					: first.verdict === 'backing_off'
						? `${first.runner_name} is backing off after repeated failures`
						: first.verdict === 'rate_limited'
							? // The detail carries the ISO reset; the surfaces localise it.
								`${first.runner_name} hit its usage limit — ${first.detail.replace(/^usage limit reached — /, '')}`
							: `waiting for capacity on ${first.runner_name}`;
	const queue =
		input.queuePosition !== null && input.queuePosition > 0
			? ` (${input.queuePosition} eligible issue${input.queuePosition === 1 ? '' : 's'} ahead)`
			: '';
	return `Eligible — ${why}${queue}`;
}

/**
 * Renders a rule's scope the way `tines routing list` does, resolving the
 * project / state / label names in one round trip for the whole set.
 */
async function describeRules(
	db: Kysely<Database>,
	rules: {
		id: string;
		project_id: string | null;
		workflow_state_id: string | null;
		label_id: string | null;
	}[]
): Promise<{ rule_id: string; scope_label: string }[]> {
	if (rules.length === 0) return [];
	const ids = <T>(xs: (T | null)[]) => [...new Set(xs.filter((x): x is T => x !== null))];
	const projectIds = ids(rules.map((r) => r.project_id));
	const stateIds = ids(rules.map((r) => r.workflow_state_id));
	const labelIds = ids(rules.map((r) => r.label_id));
	const [projects, states, labels] = await Promise.all([
		projectIds.length
			? db.selectFrom('project').select(['id', 'name']).where('id', 'in', projectIds).execute()
			: [],
		stateIds.length
			? db.selectFrom('workflow_state').select(['id', 'name']).where('id', 'in', stateIds).execute()
			: [],
		labelIds.length
			? db.selectFrom('label').select(['id', 'name']).where('id', 'in', labelIds).execute()
			: []
	]);
	const byId = (rows: { id: string; name: string }[]) => new Map(rows.map((r) => [r.id, r.name]));
	const projectNames = byId(projects);
	const stateNames = byId(states);
	const labelNames = byId(labels);
	return rules.map((rule) => ({
		rule_id: rule.id,
		scope_label: scopeLabel({
			projectId: rule.project_id,
			projectName: rule.project_id ? (projectNames.get(rule.project_id) ?? null) : null,
			workflowStateId: rule.workflow_state_id,
			stateName: rule.workflow_state_id ? (stateNames.get(rule.workflow_state_id) ?? null) : null,
			labelId: rule.label_id,
			labelName: rule.label_id ? (labelNames.get(rule.label_id) ?? null) : null
		})
	}));
}
