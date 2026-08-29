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
	type DispatchExplainer,
	type DispatchTarget,
	type Issue
} from '@tines/shared';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { issueQuery, serializeIssue } from '$lib/server/api/issues';
import { runQuery, serializeRun } from '$lib/server/api/runs';
import {
	loadActiveCounts,
	loadDispatchSettings,
	loadEligibleIssues,
	loadEngineRules,
	loadEngineRunners,
	targetsForIssue,
	type EngineRule
} from './engine';
import { matchRule, resolveTier, targetVerdict } from './logic';

function ruleScopeLabel(
	rule: EngineRule,
	names: { project: string | null; state: string | null }
): string {
	const parts: string[] = [];
	if (rule.project_id) parts.push(`project ${names.project ?? rule.project_id}`);
	if (rule.workflow_state_id) parts.push(`state ${names.state ?? rule.workflow_state_id}`);
	return parts.length > 0 ? parts.join(' · ') : 'global';
}

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
		pinned_tier: issue.pinned_tier
	};
	const { targets, rule, pinned } = targetsForIssue(candidateShape, rules);

	let matchedRule: DispatchExplainer['matched_rule'] = null;
	if (rule) {
		const [project, state] = await Promise.all([
			rule.project_id
				? db.selectFrom('project').select('name').where('id', '=', rule.project_id).executeTakeFirst()
				: null,
			rule.workflow_state_id
				? db
						.selectFrom('workflow_state')
						.select('name')
						.where('id', '=', rule.workflow_state_id)
						.executeTakeFirst()
				: null
		]);
		matchedRule = {
			rule_id: rule.id,
			scope_label: ruleScopeLabel(rule, { project: project?.name ?? null, state: state?.name ?? null })
		};
	}

	// The eligibility checks, in the order the engine applies them.
	const category = issue.effective_state.category;
	const notReadyDetail = issue.duplicate_of
		? `duplicate of ${issue.duplicate_of.project_name}/${issue.duplicate_of.number}`
		: issue.open_blockers.length > 0
			? `blocked by ${issue.open_blockers.map((b) => `${b.project_name}/${b.number}`).join(', ')}`
			: null;
	const checks: DispatchCheck[] = [
		{
			name: 'automation_enabled',
			ok: settings.enabled,
			detail: settings.enabled ? 'automation is on' : 'the kill switch is off — nothing dispatches'
		},
		{
			name: 'state_active',
			ok: category === 'active',
			detail: `state ${issue.effective_state.name} (${category})${category === 'active' ? '' : ' — agents only take on active states'}`
		},
		{
			name: 'ready',
			ok: notReadyDetail === null,
			detail: notReadyDetail ?? 'ready — not a duplicate, no open blockers'
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
				: `${issue.attempt_count} strike${issue.attempt_count === 1 ? '' : 's'} so far`
		},
		{
			name: 'routed',
			ok: targets.length > 0,
			detail: pinned
				? `pinned to ${issue.pinned_runner_name ?? issue.pinned_runner_id}${issue.pinned_tier ? ` (tier ${issue.pinned_tier})` : ''} — replaces rule matching`
				: rule
					? targets.length > 0
						? `matched the ${matchedRule!.scope_label} rule`
						: `matched the ${matchedRule!.scope_label} rule, but it has no targets`
					: 'no matching routing rule — automation is opt-in via rules'
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

	// Queue position, only for eligible-but-waiting: among eligible issues
	// that would actually route somewhere, how many are ahead in the
	// oldest-`updated_at`-first queue.
	let queuePosition: number | null = null;
	if (eligible && !firstOk) {
		const eligibleIssues = await loadEligibleIssues(db, userId);
		const routed = eligibleIssues.filter((c) => {
			if (c.pinned_runner_id) return true;
			const r = matchRule({ project_id: c.project_id, state_id: c.state_id }, rules);
			return (r?.targets.length ?? 0) > 0;
		});
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
		targets: targetVerdicts,
		parked: issue.needs_attention,
		attempt_count: issue.attempt_count,
		attempt_limit: settings.attemptLimit,
		active_run: activeRun,
		queue_position: queuePosition,
		verdict: verdictLine({ issue, settings, checks, targets: targetVerdicts, activeRun, queuePosition })
	};
}

/** The one-line human verdict the issue page and CLI lead with. */
function verdictLine(input: {
	issue: Issue;
	settings: { enabled: boolean };
	checks: DispatchCheck[];
	targets: DispatchTarget[];
	activeRun: AgentRun | null;
	queuePosition: number | null;
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
		return issue.pinned_runner_id
			? 'Pinned to a removed runner — clear the pin'
			: 'No matching routing rule — nothing will dispatch';
	}
	const firstOk = input.targets.find((t) => t.verdict === 'ok');
	if (firstOk) return `Eligible — would dispatch to ${firstOk.runner_name} next pass`;
	const first = input.targets[0];
	const why =
		first.verdict === 'paused'
			? `${first.runner_name} is paused`
			: first.verdict === 'offline'
				? `${first.runner_name} is offline`
				: first.verdict === 'backing_off'
					? `${first.runner_name} is backing off after launch failures`
					: `waiting for capacity on ${first.runner_name}`;
	const queue =
		input.queuePosition !== null && input.queuePosition > 0
			? ` (${input.queuePosition} eligible issue${input.queuePosition === 1 ? '' : 's'} ahead)`
			: '';
	return `Eligible — ${why}${queue}`;
}
