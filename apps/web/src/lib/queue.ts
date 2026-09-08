/** Derivations over the Now row's groups, shared by the panel and the page (Tines/256). */
import type { QueueGroup } from '@tines/shared';

/**
 * Waiting issues per state id.
 *
 * The API groups by `{state_id, verdict, runner_id}`, so one state legitimately
 * appears in several groups — two rules differing only by label can route it to
 * two runners, and `targetVerdict` orders `quota_exhausted` last, so one group
 * can read `quota_exhausted` while its sibling reads `offline`. Anything that
 * prefills a per-state limit has to sum them: keeping the last group's count
 * (what `Object.fromEntries` does) under-provisions the state it was invoked
 * for, which is exactly what the remedy exists to prevent.
 */
export function waitingCountsByState(groups: QueueGroup[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const g of groups) out[g.state_id] = (out[g.state_id] ?? 0) + g.count;
	return out;
}
