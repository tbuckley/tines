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
	type DispatchTargetVerdict,
	type ModelTier,
	type QuotaPolicy,
	type RoutingTarget
} from '@tines/shared';

// ---------------------------------------------------------------------------
// Rule matching (winner-take-all; project above state — see routing.ts)

export interface MatchableRule {
	id: string;
	project_id: string | null;
	workflow_state_id: string | null;
	targets: RoutingTarget[];
}

function specificity(rule: {
	project_id: string | null;
	workflow_state_id: string | null;
}): number {
	return (rule.project_id ? 2 : 0) + (rule.workflow_state_id ? 1 : 0);
}

/**
 * The most specific rule matching the issue's project and current state:
 * `project ∧ state` > `project` > `state` > global. No fallback across
 * rules — only the winner's targets are ever walked.
 */
export function matchRule<T extends MatchableRule>(
	issue: { project_id: string; state_id: string },
	rules: T[]
): T | null {
	let best: T | null = null;
	for (const rule of rules) {
		if (rule.project_id && rule.project_id !== issue.project_id) continue;
		if (rule.workflow_state_id && rule.workflow_state_id !== issue.state_id) continue;
		if (!best || specificity(rule) > specificity(best)) best = rule;
	}
	return best;
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
		smartest: 'claude-fable-5',
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
	const overrides = parseJson<Record<string, { model?: string } | string>>(runner.tiers);
	const override = overrides?.[tier];
	if (override) {
		const model = typeof override === 'string' ? override : override.model;
		if (model) return { tier, model };
	}
	const builtins = builtinTierModels(runner);
	return { tier, model: builtins?.[tier] ?? null };
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

// ---------------------------------------------------------------------------
// Target verdicts: why a runner is (not) assignable right now

export interface VerdictRunner {
	id: string;
	type: string;
	status: string;
	max_concurrent: number;
	last_seen_at: number | null;
	backoff_until: number | null;
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
	if (runner.backoff_until !== null && runner.backoff_until > now) {
		return {
			verdict: 'backing_off',
			detail: `backing off after repeated failures until ${new Date(runner.backoff_until).toISOString()}`
		};
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
