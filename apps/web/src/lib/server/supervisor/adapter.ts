/**
 * The per-runner-type adapter interface. Provider calls live behind it so
 * the dispatch engine (and its tests) never touch a provider API: the engine
 * works purely against this interface, with a fake for unit tests (see
 * fake-adapter.ts) and the Claude managed adapter in claude-adapter.ts.
 *
 * Worker-imported (via the engine): relative/package imports only, no `$lib`.
 */
import type { AgentRunUsage, EffectiveContext, IssueDetail, ModelTier } from '@tines/shared';
import type { ResolvedEnvEntry } from '../api/context';
import { createClaudeAdapter } from './claude-adapter';

/** What launch() gets: everything identifying the run and its delivery. */
export interface AdapterLaunchInput {
	runId: string;
	issueId: string;
	runner: { id: string; type: string; name: string; config: string; max_run_minutes: number };
	tier: ModelTier;
	model: string | null;
	/** Claim-time resolved effort. Adapters must not reread mutable tiers. */
	effort?: string | null;
	/** Persist provider configuration evidence before later launch steps can fail. */
	recordEffortEvidence?: (evidence: {
		status: 'accepted_unconfirmed' | 'confirmed' | 'rejected';
		transport: 'managed_agent_config';
		attempted_effort: string;
		observed_model?: string;
		observed_effort?: string;
		provider_agent_id?: string;
		reason?: string;
	}) => Promise<void>;
	/**
	 * The plaintext run key, for out-of-prompt delivery (vault credential /
	 * egress-proxy header). Never logged, never stored beyond its hash.
	 */
	runKey: string;
	/**
	 * Launch material for a run in a shared project (Tines/752), built and
	 * witness-guarded before the key was minted. When present the adapter
	 * uses it for the issue, prompts, context and env and fetches none of
	 * them itself. Only adapters with `sharedMaterial` are given shared runs.
	 */
	material?: AdapterLaunchMaterial;
}

export interface AdapterLaunchMaterial {
	issue: IssueDetail;
	context: EffectiveContext;
	launchPrompt: string;
	resumePrompt: string;
	/** Resolved values; never inside `context`. */
	env: ResolvedEnvEntry[];
	digest: string;
}

export interface AdapterLaunchResult {
	provider_session_id?: string | null;
	provider_url?: string | null;
	/** Serialized provider bookkeeping to store on the run (`provider_meta`). */
	provider_meta?: string | null;
}

/** A run as the adapter sees it for poll/cancel/GC. */
export interface AdapterRunRef {
	id: string;
	runner_id: string;
	provider_session_id: string | null;
	/** The stored provider bookkeeping (adapter-owned JSON), when any. */
	provider_meta?: string | null;
}

export interface AdapterPollResult {
	/** Terminal provider status, when the session has ended. */
	status?: 'completed' | 'failed' | 'canceled';
	/** New log content to append since the last poll. */
	logChunk?: string;
	/** Cumulative usage snapshot (replaces the stored record). */
	usage?: AgentRunUsage;
	error?: string | null;
	/** Updated provider bookkeeping to store back (poll cursor etc.). */
	provider_meta?: string | null;
}

/**
 * What `finalizeEnd` gets: the server's authoritative judgment of an end,
 * which is the only thing that can decide whether a provider session is
 * garbage or a resumable conversation.
 */
export interface AdapterEndInput {
	user_id: string;
	issue_id: string;
	model: string | null;
	effort?: string | null;
	/** The recorded run outcome; only `advanced` can retain. */
	outcome: string | null;
	/** Whether the issue's state at end was an `awaiting_human` one. */
	ended_in_awaiting_state: boolean;
	now: number;
}

export interface RunnerAdapter {
	/**
	 * 'immediate': the supervisor launches in the dispatch pass (managed
	 * types; the fake). 'poll': the run stays `assigned` until the runner's
	 * daemon collects it — launch materials and the run key are minted at
	 * poll-delivery, not here.
	 */
	launchMode: 'immediate' | 'poll';
	/** Accepts `AdapterLaunchInput.material`; shared runs are refused otherwise. */
	sharedMaterial?: boolean;
	/**
	 * Create the provider session for a claimed run. Throwing is a *launch
	 * failure*: the error lands on the run, the runner backs off, and the
	 * pass retries the next target — never a strike on the issue.
	 */
	launch(input: AdapterLaunchInput): Promise<AdapterLaunchResult>;
	/**
	 * Reconcile provider-side status/logs/usage for one active run. Called by
	 * the sweep; the engine applies the result (log append, usage write,
	 * terminal end judgment). Throwing skips this run until the next sweep.
	 */
	poll?(run: AdapterRunRef): Promise<AdapterPollResult>;
	/** Best-effort kill of the provider session / harness process. */
	cancel(run: AdapterRunRef): Promise<void>;
	/**
	 * Called after the authoritative `endRun`, for adapters that own
	 * provider resources outliving the run: retain them for a resume, or
	 * dispose of them now. Best-effort — the sweep's GC is the backstop if
	 * this throws or the worker dies first.
	 */
	finalizeEnd?(run: AdapterRunRef, input: AdapterEndInput): Promise<void>;
	/**
	 * Per-runner sweep housekeeping (managed types): garbage-collect provider
	 * resources of ended runs (per-run vault credentials, un-archived
	 * sessions) and cancel orphaned provider sessions tagged with unknown or
	 * ended run ids (launch reconciliation). Best-effort; errors are logged
	 * and retried next sweep.
	 */
	sweepRunner?(runner: { id: string; user_id: string }, now: number): Promise<void>;
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
 * The production registry for an environment. Built per call site (the
 * managed adapters need `env` for the DB and the encryption-key binding);
 * the result is cheap — adapters hold no connections. Gemini is absent
 * until its milestone lands; the engine skips unknown types.
 */
export function buildAdapters(env: Env): AdapterRegistry {
	return {
		local: localAdapter,
		claude_managed: createClaudeAdapter(env)
	};
}
