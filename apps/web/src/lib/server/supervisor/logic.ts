/**
 * Pure dispatch logic: rule matching, tier→model resolution, target
 * verdicts, and launch-failure backoff. No DB access — the engine and the
 * explainer both build on these so they can never disagree.
 *
 * Imported (via the engine) from the custom worker entry, so this module and
 * everything it imports must stick to relative/package imports: no `$lib`.
 */
import {
	RUN_LOG_MAX_BYTES,
	RUNNER_ONLINE_WINDOW_MS,
	isTierOnlyTargets,
	routingScopeSpecificity,
	type DispatchTargetVerdict,
	type ModelTier,
	type QuotaPolicy,
	type QueueVerdict,
	type RoutingTarget
} from '@tines/shared';
import { MANAGED_CLAUDE_EFFORTS, supportedEfforts, type EffortCapabilities } from '@tines/shared';

// ---------------------------------------------------------------------------
// Rule matching (winner-take-all; project above state — see routing.ts)

export interface MatchableRule {
	id: string;
	project_id: string | null;
	workflow_state_id: string | null;
	label_id: string | null;
	targets: RoutingTarget[];
}

/** The issue dimensions a rule can be scoped to. Labels are set-valued. */
export interface MatchableIssue {
	project_id: string;
	state_id: string;
	label_ids: string[];
}

/**
 * The most specific rule matching the issue, or an ambiguity.
 *
 * Order: `label ∧ project ∧ state` (7) > `label ∧ project` (6) >
 * `label ∧ state` (5) > `label` (4) > `project ∧ state` (3) > `project` (2)
 * > `state` (1) > global (0). No fallback across rules — only the winner's
 * targets are ever walked.
 *
 * Because an issue carries a *set* of labels, two rules scoped to different
 * labels can both match at the same specificity, and then neither is more
 * specific. That **fails closed**: `rule` is null and `ambiguous` names the
 * tied rules, so the issue is not dispatched and the explainer can say why.
 * Routing on an arbitrary winner would silently send, say, a `docs`+`security`
 * issue wherever the `docs` rule points — the exact failure the specificity
 * order exists to prevent.
 */
export function resolveRule<T extends MatchableRule>(
	issue: MatchableIssue,
	rules: T[]
): { rule: T | null; ambiguous: T[] } {
	let best: T[] = [];
	let bestSpec = -1;
	for (const rule of rules) {
		if (rule.project_id && rule.project_id !== issue.project_id) continue;
		if (rule.workflow_state_id && rule.workflow_state_id !== issue.state_id) continue;
		if (rule.label_id && !issue.label_ids.includes(rule.label_id)) continue;
		const spec = routingScopeSpecificity(rule);
		if (spec > bestSpec) {
			bestSpec = spec;
			best = [rule];
		} else if (spec === bestSpec) {
			best.push(rule);
		}
	}
	if (best.length === 1) return { rule: best[0], ambiguous: [] };
	if (best.length === 0) return { rule: null, ambiguous: [] };
	return { rule: null, ambiguous: best };
}

export interface ResolvedRoute<T extends MatchableRule> {
	rule: T | null;
	runnerRule: T | null;
	tierOverride: ModelTier | null;
	effortOverride: string | null;
	effortRule: T | null;
	targets: RoutingTarget[];
	ambiguous: T[];
	failure: 'no_rule' | 'ambiguous_rule' | 'no_runner_rule' | 'no_targets' | null;
}

/** Resolve a winning rule and, for tier-only rules, its lower-priority runner source. */
export function resolveRoute<T extends MatchableRule>(
	issue: MatchableIssue,
	rules: T[]
): ResolvedRoute<T> {
	const byRank = new Map<number, T[]>();
	for (const rule of rules) {
		if (rule.project_id && rule.project_id !== issue.project_id) continue;
		if (rule.workflow_state_id && rule.workflow_state_id !== issue.state_id) continue;
		if (rule.label_id && !issue.label_ids.includes(rule.label_id)) continue;
		const rank = routingScopeSpecificity(rule);
		byRank.set(rank, [...(byRank.get(rank) ?? []), rule]);
	}
	let winner: T | null = null;
	let tierOverride: ModelTier | null = null;
	let effortOverride: string | null = null;
	let effortRule: T | null = null;
	for (let rank = 7; rank >= 0; rank--) {
		const matches = byRank.get(rank) ?? [];
		if (matches.length === 0) continue;
		if (matches.length > 1) {
			return {
				rule: winner,
				runnerRule: null,
				tierOverride,
				effortOverride,
				effortRule,
				targets: [],
				ambiguous: matches,
				failure: 'ambiguous_rule'
			};
		}
		const source = matches[0]!;
		if (!winner) winner = source;
		const wildcardEntries = source.targets.filter((target) => target.runner_id === '*');
		if (wildcardEntries.length > 0) {
			if (!isTierOnlyTargets(source.targets)) {
				return {
					rule: winner,
					runnerRule: source,
					tierOverride,
					effortOverride,
					effortRule,
					targets: [],
					ambiguous: [],
					failure: 'no_targets'
				};
			}
			tierOverride ??= source.targets[0]!.tier;
			if (effortOverride === null && source.targets[0]!.effort) {
				effortOverride = source.targets[0]!.effort;
				effortRule = source;
			}
			continue;
		}
		const targets = source.targets.map((target) => ({
			...target,
			...(tierOverride ? { tier: tierOverride } : {}),
			...(effortOverride ? { effort: effortOverride } : {})
		}));
		return {
			rule: winner,
			runnerRule: source,
			tierOverride,
			effortOverride,
			effortRule,
			targets,
			ambiguous: [],
			failure: targets.length === 0 ? 'no_targets' : null
		};
	}
	if (!winner)
		return {
			rule: null,
			runnerRule: null,
			tierOverride: null,
			effortOverride: null,
			effortRule: null,
			targets: [],
			ambiguous: [],
			failure: 'no_rule'
		};
	return {
		rule: winner,
		runnerRule: null,
		tierOverride,
		effortOverride,
		effortRule,
		targets: [],
		ambiguous: [],
		failure: 'no_runner_rule'
	};
}

/** The winning rule, or null when there is none *or* the match is ambiguous. */
export function matchRule<T extends MatchableRule>(issue: MatchableIssue, rules: T[]): T | null {
	return resolveRule(issue, rules).rule;
}

// ---------------------------------------------------------------------------
// Tiers: built-in per-type defaults, per-runner overrides

/**
 * The built-in tier→model table, maintained in code and updated as providers
 * ship models. Local runners resolve per harness: `claude_code` mirrors the
 * Claude trio (passed via --model), `codex` runs its fixed family, and a
 * custom harness has no model dimension at all.
 */
const BUILTIN_TIER_MODELS: Record<string, Record<ModelTier, string> | null> = {
	claude_managed: {
		smartest: 'claude-fable-5-1',
		balanced: 'claude-opus-5',
		cheapest: 'claude-sonnet-5'
	},
	// Provider ids below are re-verified against live docs at the start of
	// their milestones (M2 Claude, M4 Gemini) per the plan's risk flag.
	gemini_managed: {
		smartest: 'gemini-2.5-pro',
		balanced: 'gemini-2.5-flash',
		cheapest: 'gemini-2.5-flash-lite'
	}
};

const LOCAL_HARNESS_TIER_MODELS: Record<string, Record<ModelTier, string> | null> = {
	claude_code: BUILTIN_TIER_MODELS.claude_managed,
	codex: {
		smartest: 'gpt-5-codex',
		balanced: 'gpt-5-codex',
		cheapest: 'gpt-5-codex'
	},
	// A custom harness cannot vary its model: it satisfies any tier with its
	// fixed configuration, and the run records the model as unknown.
	custom: null
};

export interface TierResolvable {
	type: string;
	default_tier: string;
	/** Raw JSON columns as stored. */
	tiers: string | null;
	config: string;
}

/**
 * The built-in tier→model table applying to a runner (type- and, for local
 * runners, harness-aware). Null = the runner cannot vary its model (custom
 * harness) and tiers don't apply. Serialized as `Runner.tier_models` so the
 * tier editor and the stale-override marker never duplicate the table.
 */
export function builtinTierModels(
	runner: Pick<TierResolvable, 'type' | 'config'>
): Record<ModelTier, string> | null {
	if (runner.type === 'local') {
		const harness = parseJson<{ harness?: string }>(runner.config)?.harness ?? 'claude_code';
		return LOCAL_HARNESS_TIER_MODELS[harness] ?? null;
	}
	return BUILTIN_TIER_MODELS[runner.type] ?? null;
}

export interface ResolvedTier {
	tier: ModelTier;
	/** Null when the runner cannot vary its model (custom harness). */
	model: string | null;
	/** Runner-tier fallback, when configured. */
	effort: string | null;
}

function parseJson<T>(raw: string | null): T | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/**
 * Resolves a requested tier (a rule entry's or a pin's; null = the runner's
 * `default_tier`, itself defaulting to `balanced`) to the concrete model the
 * run will record. Per-runner `tiers` overrides win over the built-ins;
 * unlisted tiers fall back to them.
 */
export function resolveTier(runner: TierResolvable, requested: ModelTier | null): ResolvedTier {
	const tier = requested ?? ((runner.default_tier || 'balanced') as ModelTier);
	const overrides = parseJson<Record<string, { model?: string; effort?: string } | string>>(
		runner.tiers
	);
	const override = overrides?.[tier];
	if (override) {
		const model = typeof override === 'string' ? override : override.model;
		if (model)
			return {
				tier,
				model,
				effort: typeof override === 'string' ? null : (override.effort ?? null)
			};
	}
	const builtins = builtinTierModels(runner);
	return { tier, model: builtins?.[tier] ?? null, effort: null };
}

export type EffortDeliveryMode = 'enforce' | 'legacy_tier' | 'none';
export interface EffortResolution {
	requested: string | null;
	resolved: string | null;
	deliveryMode: EffortDeliveryMode;
	compatible: boolean;
	reason: string | null;
}

/** Resolve intent and eligibility against the final exact model. */
export function resolveEffort(
	runner: TierResolvable & { effort_capabilities?: string | null },
	tier: ResolvedTier,
	routedEffort: string | null
): EffortResolution {
	const resolved = routedEffort ?? tier.effort;
	if (!resolved)
		return {
			requested: null,
			resolved: null,
			deliveryMode: 'none',
			compatible: true,
			reason: null
		};
	if (!tier.model)
		return {
			requested: routedEffort,
			resolved,
			deliveryMode: 'none',
			compatible: false,
			reason: 'unsupported_harness: this harness has no model effort control'
		};
	if (runner.type === 'claude_managed') {
		const allowed = MANAGED_CLAUDE_EFFORTS[tier.model];
		return allowed?.includes(resolved)
			? {
					requested: routedEffort,
					resolved,
					deliveryMode: 'enforce',
					compatible: true,
					reason: null
				}
			: {
					requested: routedEffort,
					resolved,
					deliveryMode: 'none',
					compatible: false,
					reason: `unsupported_effort: ${tier.model} does not support ${resolved}`
				};
	}
	if (runner.type !== 'local')
		return {
			requested: routedEffort,
			resolved,
			deliveryMode: 'none',
			compatible: false,
			reason: 'unsupported_harness: this provider does not accept effort'
		};
	if (!runner.effort_capabilities) {
		return routedEffort
			? {
					requested: routedEffort,
					resolved,
					deliveryMode: 'none',
					compatible: false,
					reason: 'daemon_upgrade_required: reconnect with an effort-capable daemon'
				}
			: { requested: null, resolved, deliveryMode: 'legacy_tier', compatible: true, reason: null };
	}
	let capabilities: EffortCapabilities | null = null;
	try {
		capabilities = JSON.parse(runner.effort_capabilities) as EffortCapabilities;
	} catch {
		/* fail closed below */
	}
	const allowed = supportedEfforts(capabilities, tier.model);
	return allowed?.includes(resolved)
		? { requested: routedEffort, resolved, deliveryMode: 'enforce', compatible: true, reason: null }
		: {
				requested: routedEffort,
				resolved,
				deliveryMode: 'none',
				compatible: false,
				reason: allowed
					? `unsupported_effort: ${tier.model} allows ${allowed.join(', ')}`
					: 'capability_unavailable: exact model support was not reported'
			};
}

// ---------------------------------------------------------------------------
// Log tails: 256 KB, truncated from the head

/**
 * Appends a chunk to a log tail capped at `RUN_LOG_MAX_BYTES` (UTF-8),
 * truncating from the head. Byte math is done here in JS because SQLite's
 * `length()` counts characters. Shared by the daemon protocol's log append
 * and the sweep's managed-run polling (both must agree on the cap).
 */
export function appendLogTail(
	log: string,
	dropped: number,
	chunk: string
): { log: string; dropped: number; evicted: Uint8Array | null } {
	const combined = log + chunk;
	const bytes = new TextEncoder().encode(combined);
	if (bytes.length <= RUN_LOG_MAX_BYTES) return { log: combined, dropped, evicted: null };
	// The cut advances over any UTF-8 continuation bytes (0b10xxxxxx) so it
	// lands on a character boundary. Two reasons: the tail no longer opens
	// with a U+FFFD where a multi-byte character was sliced, and — the one
	// that matters — the evicted prefix and the tail are each independently
	// decodable, so `spilled + tail` is byte-for-byte the original log. The
	// cap is a maximum, so a tail a byte or two under it is fine.
	let cut = bytes.length - RUN_LOG_MAX_BYTES;
	while (cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut++;
	const kept = bytes.slice(cut);
	// `evicted` is the dropped bytes, handed to the caller so they can be
	// spilled to R2 rather than lost (supervisor/run-log.ts); raw bytes and
	// not a string so the caller stores exactly what was removed.
	return {
		log: new TextDecoder().decode(kept),
		dropped: dropped + cut,
		evicted: bytes.slice(0, cut)
	};
}

// ---------------------------------------------------------------------------
// Launch-failure backoff: 2× per consecutive failure, capped at 1 hour

const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

export function launchBackoffMs(consecutiveFailures: number): number {
	if (consecutiveFailures <= 0) return 0;
	return Math.min(BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), BACKOFF_MAX_MS);
}

/**
 * Longest a usage-limit hold may run before the fleet re-probes. A weekly limit
 * (or a misparsed reset) would otherwise sit for days; a daily probe costs one
 * ~1 s interrupted run and never a strike.
 */
export const RATE_LIMIT_HOLD_MAX_MS = 24 * 60 * 60 * 1000;
/** Hold applied when the provider gave no usable reset time. */
export const RATE_LIMIT_HOLD_DEFAULT_MS = 30 * 60 * 1000;
/** Slack past the reported reset: the window is not always open at that second. */
export const RATE_LIMIT_HOLD_GRACE_MS = 60 * 1000;

/**
 * How long to hold a runner whose harness reported a usage limit. A reset in
 * the past (clock skew, a stale printed time) counts as unknown.
 */
export function rateLimitHoldUntil(resumeAt: number | null | undefined, now: number): number {
	if (resumeAt === null || resumeAt === undefined || !Number.isFinite(resumeAt) || resumeAt <= now)
		return now + RATE_LIMIT_HOLD_DEFAULT_MS;
	return Math.min(resumeAt + RATE_LIMIT_HOLD_GRACE_MS, now + RATE_LIMIT_HOLD_MAX_MS);
}

// ---------------------------------------------------------------------------
// Target verdicts: why a runner is (not) assignable right now

export interface VerdictRunner {
	id: string;
	type: string;
	status: string;
	max_concurrent: number;
	last_seen_at: number | null;
	/** 0/1: a local daemon finishing its runs before a self-update restart. */
	draining: number;
	backoff_until: number | null;
	/** 'rate_limit' when the hold is a usage limit; null for the failure backoff. */
	backoff_reason: string | null;
}

/** Live concurrency the pass tracks (its own claims included). */
export interface ActiveCounts {
	total: number;
	byRunner: Map<string, number>;
	/** Active runs keyed by `state_id_at_start` (the roster's counting key). */
	byStartState: Map<string, number>;
}

export function quotaLimitForState(quota: QuotaPolicy, stateId: string): number {
	if (quota.type === 'global_cap') return quota.limit;
	return quota.overrides[stateId] ?? quota.default_limit;
}

/** True when the quota policy has room for a run starting from `stateId`. */
export function quotaHasRoom(quota: QuotaPolicy, counts: ActiveCounts, stateId: string): boolean {
	if (quota.type === 'global_cap') return counts.total < quota.limit;
	return (counts.byStartState.get(stateId) ?? 0) < quotaLimitForState(quota, stateId);
}

export interface TargetVerdictResult {
	verdict: DispatchTargetVerdict;
	detail: string;
}

/**
 * Why this runner can(not) take an issue currently in `stateId` right now.
 * The claim's guarded INSERT re-checks caps and quota atomically; this is
 * the pass's selection logic and the explainer's rendering, kept identical.
 */
export function targetVerdict(
	runner: VerdictRunner,
	counts: ActiveCounts,
	quota: QuotaPolicy,
	stateId: string,
	now: number
): TargetVerdictResult {
	if (runner.status === 'paused') return { verdict: 'paused', detail: 'runner is paused' };
	if (
		runner.type === 'local' &&
		(runner.last_seen_at === null || now - runner.last_seen_at > RUNNER_ONLINE_WINDOW_MS)
	) {
		return {
			verdict: 'offline',
			detail:
				runner.last_seen_at === null
					? 'daemon has never connected'
					: `daemon last seen ${Math.round((now - runner.last_seen_at) / 60_000)}m ago`
		};
	}
	// After offline, not before: a daemon that died mid-drain is offline, and
	// that is the truer story. A live one is back within seconds of its last
	// run ending, so this rarely outlasts one run.
	if (runner.type === 'local' && runner.draining === 1) {
		return {
			verdict: 'draining',
			detail: 'daemon is finishing its runs before restarting to update'
		};
	}
	if (runner.backoff_until !== null && runner.backoff_until > now) {
		const until = new Date(runner.backoff_until).toISOString();
		// A usage limit is the provider's clock, not this runner misbehaving —
		// say so, or the fleet reads as broken when it is merely waiting.
		return runner.backoff_reason === 'rate_limit'
			? { verdict: 'rate_limited', detail: `usage limit reached — resumes ${until}` }
			: { verdict: 'backing_off', detail: `backing off after repeated failures until ${until}` };
	}
	const active = counts.byRunner.get(runner.id) ?? 0;
	if (active >= runner.max_concurrent) {
		return {
			verdict: 'at_capacity',
			detail: `at max_concurrent (${active}/${runner.max_concurrent})`
		};
	}
	if (!quotaHasRoom(quota, counts, stateId)) {
		return {
			verdict: 'quota_exhausted',
			detail:
				quota.type === 'global_cap'
					? `global cap reached (${counts.total}/${quota.limit})`
					: `state roster full (${counts.byStartState.get(stateId) ?? 0}/${quotaLimitForState(quota, stateId)} for this state)`
		};
	}
	return { verdict: 'ok', detail: 'available' };
}

// ---------------------------------------------------------------------------
// Queue verdicts: why a *waiting* issue is waiting (the Now row, Tines/256)

/**
 * The target that speaks for an issue: the first `ok` one, because that is
 * where dispatch would send it, else the first in preference order. Shared by
 * the explainer's verdict line and the fleet queue's grouping, so the board
 * and the per-issue explanation can never name different runners.
 */
export function speakingTarget<T extends { verdict: DispatchTargetVerdict }>(
	targets: T[]
): T | null {
	return targets.find((t) => t.verdict === 'ok') ?? targets[0] ?? null;
}

export interface QueueVerdictInput {
	/** The kill switch. */
	enabled: boolean;
	parked: boolean;
	/** The issue carries a pin (which replaces rule matching entirely). */
	pinned: boolean;
	/** A rule matched — its target list may still be empty. */
	hasRule: boolean;
	/** Two rules tied at equal specificity. */
	ambiguous: boolean;
	/** Targets whose runner still exists, in preference order. */
	targets: { verdict: DispatchTargetVerdict }[];
}

/**
 * Why one waiting issue is waiting, in the same order the explainer's verdict
 * line applies its cases — the two are tested against each other, so a change
 * here without one there is a test failure rather than a silent disagreement.
 */
export function queueVerdict(input: QueueVerdictInput): QueueVerdict {
	if (!input.enabled) return 'automation_off';
	if (input.parked) return 'parked';
	if (input.targets.length === 0) {
		// A pin whose runner was deleted resolves to a target the runner map
		// cannot answer, so it arrives here with an empty list.
		if (input.pinned) return 'pin_missing';
		if (input.ambiguous) return 'ambiguous_rule';
		return input.hasRule ? 'no_targets' : 'no_rule';
	}
	return speakingTarget(input.targets)!.verdict;
}

/**
 * The explainer's "would this issue route somewhere?" predicate, which defines
 * the queue whose positions it reports. Shared so the board's `queue_position`
 * counts the same issues the explainer does.
 */
export function isRoutedCandidate<T extends MatchableRule>(
	issue: MatchableIssue & { pinned_runner_id: string | null },
	rules: T[]
): boolean {
	if (issue.pinned_runner_id) return true;
	// An ambiguous match resolves to null here, so a tied issue is correctly
	// excluded from a queue it would never reach.
	const route = resolveRoute(
		{ project_id: issue.project_id, state_id: issue.state_id, label_ids: issue.label_ids },
		rules
	);
	return route.targets.length > 0;
}
