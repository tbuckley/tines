/**
 * The per-runner-type adapter interface. Provider calls live behind it so
 * the dispatch engine (and its tests) never touch a provider API: the engine
 * works purely against this interface, with the managed adapters arriving in
 * later milestones and a fake for unit tests (see fake-adapter.ts).
 *
 * Worker-imported (via the engine): relative/package imports only, no `$lib`.
 */
import type { ModelTier } from '@tines/shared';

/** What launch() gets: everything identifying the run and its delivery. */
export interface AdapterLaunchInput {
	runId: string;
	issueId: string;
	runner: { id: string; type: string; name: string; config: string; max_run_minutes: number };
	tier: ModelTier;
	model: string | null;
	/**
	 * The plaintext run key, for out-of-prompt delivery (vault credential /
	 * egress-proxy header). Never logged, never stored beyond its hash.
	 */
	runKey: string;
}

export interface AdapterLaunchResult {
	provider_session_id?: string | null;
	provider_url?: string | null;
}

/** A run as the adapter sees it for poll/cancel. */
export interface AdapterRunRef {
	id: string;
	runner_id: string;
	provider_session_id: string | null;
}

export interface AdapterPollResult {
	/** Terminal provider status, when the session has ended. */
	status?: 'completed' | 'failed' | 'canceled';
	/** New log content to append since the last poll. */
	logChunk?: string;
	usage?: Record<string, unknown>;
	error?: string | null;
}

export interface RunnerAdapter {
	/**
	 * 'immediate': the supervisor launches in the dispatch pass (managed
	 * types; the fake). 'poll': the run stays `assigned` until the runner's
	 * daemon collects it — launch materials and the run key are minted at
	 * poll-delivery, not here.
	 */
	launchMode: 'immediate' | 'poll';
	/**
	 * Create the provider session for a claimed run. Throwing is a *launch
	 * failure*: the error lands on the run, the runner backs off, and the
	 * pass retries the next target — never a strike on the issue.
	 */
	launch(input: AdapterLaunchInput): Promise<AdapterLaunchResult>;
	/** Reconcile provider-side status/logs/usage (sweep-driven; later milestones). */
	poll?(run: AdapterRunRef): Promise<AdapterPollResult>;
	/** Best-effort kill of the provider session / harness process. */
	cancel(run: AdapterRunRef): Promise<void>;
	/** One-time credential setup at runner creation (managed types). */
	setupCredentials?(runner: { id: string; config: string }): Promise<void>;
}

/**
 * Local runners: assignment is delivered by the daemon's next poll (the
 * guarded `assigned → launching` flip, Phase 3), so the supervisor-side
 * launch is a no-op and cancel is signalled via the poll response's
 * `cancels` list rather than an outbound call.
 */
export const localAdapter: RunnerAdapter = {
	launchMode: 'poll',
	launch: () => Promise.resolve({}),
	cancel: () => Promise.resolve()
};

export type AdapterRegistry = Record<string, RunnerAdapter>;

/**
 * The production registry. Managed types are absent until their milestones
 * land — a rule targeting one simply cannot exist yet (runner creation
 * rejects managed types), so lookups never miss in practice; the engine
 * still guards against an unknown type by skipping the target.
 */
export const defaultAdapters: AdapterRegistry = {
	local: localAdapter
};
