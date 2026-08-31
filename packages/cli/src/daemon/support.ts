/**
 * Pure daemon logic — harness invocation building, command-template
 * expansion, and log-chunk batching — kept free of I/O so it is
 * unit-testable without a daemon (see support.test.ts). The loop itself
 * lives in daemon.ts.
 */
import { delimiter } from 'node:path';

export type HarnessKind = 'claude_code' | 'codex' | 'custom';

export const HARNESS_KINDS: readonly HarnessKind[] = ['claude_code', 'codex', 'custom'];

/** POSIX single-quote escaping: safe interpolation into an `sh -c` string. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface HarnessInput {
	workspace: string;
	promptFile: string;
	/** The full prompt text (preamble + context + issue block). */
	prompt: string;
	/** Resolved model, or null when the harness cannot vary it. */
	model: string | null;
}

/**
 * Expands a custom command template: `{prompt_file}`, `{workspace}`, and
 * `{model}` are substituted shell-quoted (an absent model becomes `''`), so
 * paths with spaces survive the `sh -c` round trip.
 */
export function expandCommandTemplate(template: string, input: HarnessInput): string {
	return template
		.replaceAll('{prompt_file}', shellQuote(input.promptFile))
		.replaceAll('{workspace}', shellQuote(input.workspace))
		.replaceAll('{model}', input.model ? shellQuote(input.model) : "''");
}

export interface HarnessInvocation {
	file: string;
	args: string[];
}

/**
 * The argv to launch a harness with (cwd = the workspace). `claude_code`
 * reads the prompt from prompt.md via stdin redirection — never argv, whose
 * ARG_MAX would truncate a large stitched prompt — with the model via
 * `--model`; codex gets the prompt as its exec argument; a custom template
 * runs under `sh -c` with the placeholders expanded.
 */
export function buildHarnessInvocation(
	spec: { harness: HarnessKind; command?: string },
	input: HarnessInput
): HarnessInvocation {
	switch (spec.harness) {
		case 'claude_code':
			return {
				file: 'sh',
				args: [
					'-c',
					`claude -p${input.model ? ` --model ${shellQuote(input.model)}` : ''} < ${shellQuote(input.promptFile)}`
				]
			};
		case 'codex':
			return {
				file: 'codex',
				args: ['exec', ...(input.model ? ['--model', input.model] : []), input.prompt]
			};
		case 'custom': {
			if (!spec.command) throw new Error('the custom harness needs a --command template');
			return { file: 'sh', args: ['-c', expandCommandTemplate(spec.command, input)] };
		}
	}
}

// ---------------------------------------------------------------------------
// The run table: live-run bookkeeping with the settle/cleanup state machine
// factored out of the daemon loop so it is unit-testable (support.test.ts).

export interface ManagedRun {
	runId: string;
	workspace: string;
	/** Set once the harness spawned. */
	pid?: number;
	/** Supervisor-settled (poll `cancels`): kill, never finish-report. */
	canceled: boolean;
	/** The daemon's own timeout fired; colors the finish report. */
	timedOut: boolean;
	/** A finish/cancel path owns this run's end; everyone else stands down. */
	settled: boolean;
	/** Drains pending log chunks before a finish report. */
	flush?: () => Promise<void>;
}

export interface RunTableEffects<T extends ManagedRun> {
	/** Report the finish to the supervisor; rejections are the caller-side log. */
	finish(run: T, status: 'completed' | 'failed', error?: string): Promise<void>;
	/** Tear down the run's local traces: workspace, timers (idempotent). */
	release(run: T): void;
	/** Persist the run → pid state file (membership or pid changed). */
	persist(): void;
	log(message: string): void;
}

export class RunTable<T extends ManagedRun> {
	private readonly runs = new Map<string, T>();

	constructor(private readonly effects: RunTableEffects<T>) {}

	get size(): number {
		return this.runs.size;
	}

	ids(): string[] {
		return [...this.runs.keys()];
	}

	values(): T[] {
		return [...this.runs.values()];
	}

	has(runId: string): boolean {
		return this.runs.has(runId);
	}

	track(run: T): void {
		this.runs.set(run.runId, run);
		this.effects.persist();
	}

	/** Call after setting a run's pid so the state file reflects it. */
	persist(): void {
		this.effects.persist();
	}

	/** Removes the run and releases its local traces. Safe to call twice. */
	cleanup(run: T): void {
		this.runs.delete(run.runId);
		this.effects.persist();
		this.effects.release(run);
	}

	/**
	 * Ends a run: flush logs, finish-report, clean up. On a run someone
	 * already settled (a poll-cancel racing a clone failure or spawn error)
	 * this still cleans up — the slot, workspace, and state entry must never
	 * outlive the run — but reports nothing.
	 */
	async finishAndCleanup(run: T, status: 'completed' | 'failed', error?: string): Promise<void> {
		if (run.settled) return this.cleanup(run);
		run.settled = true;
		await run.flush?.();
		try {
			await this.effects.finish(run, status, error);
			this.effects.log(`run ${run.runId} finished: ${status}${error ? ` (${error})` : ''}`);
		} catch (err) {
			// A settled run (canceled/timed out/swept server-side) is fine; the
			// supervisor's word stands.
			this.effects.log(
				`finish report for run ${run.runId} not accepted: ${err instanceof Error ? err.message : String(err)}`
			);
		}
		this.cleanup(run);
	}

	/**
	 * Marks a supervisor-settled run (`cancels`): kill, do NOT finish-report.
	 * Returns the run for the caller to kill when it was live; null when
	 * unknown or already settled. A run with no pid yet (still materializing)
	 * is cleaned up by the launch path's next settled check.
	 */
	markCanceled(runId: string): T | null {
		const run = this.runs.get(runId);
		if (!run || run.settled) return null;
		run.canceled = true;
		run.settled = true;
		return run;
	}
}

export interface LogBatcherOptions {
	/** Flush as soon as the buffer reaches this many bytes. Default 8 KB. */
	maxBytes?: number;
	/** Flush at most this long after the first unflushed byte. Default 2 s. */
	intervalMs?: number;
	/** Send failures land here (default: swallowed) — the tail is best-effort. */
	onError?: (err: unknown) => void;
}

/**
 * Batches harness output into log-append chunks: a chunk is sent when the
 * buffer reaches `maxBytes`, or `intervalMs` after output first arrived —
 * so a chatty harness doesn't produce a request per line and a quiet one
 * still streams promptly. Sends are serialized (chunks arrive in order).
 */
export class LogBatcher {
	private buffer = '';
	private timer: ReturnType<typeof setTimeout> | null = null;
	private sending: Promise<void> = Promise.resolve();

	constructor(
		private readonly send: (chunk: string) => Promise<void>,
		private readonly opts: LogBatcherOptions = {}
	) {}

	append(text: string): void {
		if (!text) return;
		this.buffer += text;
		if (Buffer.byteLength(this.buffer, 'utf8') >= (this.opts.maxBytes ?? 8 * 1024)) {
			void this.flush();
		} else if (!this.timer) {
			this.timer = setTimeout(() => void this.flush(), this.opts.intervalMs ?? 2000);
			this.timer.unref?.();
		}
	}

	/** Sends whatever is buffered now; resolves when every send so far settled. */
	flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const chunk = this.buffer;
		this.buffer = '';
		if (chunk) {
			this.sending = this.sending
				.then(() => this.send(chunk))
				.catch((err) => this.opts.onError?.(err));
		}
		return this.sending;
	}
}

// ---------------------------------------------------------------------------
// The agent-facing CLI: the daemon keeps a current `tines` in its own prefix
// and injects it into the harness environment, so the prompt an agent reads
// and the CLI it runs come from the same release (Tines/71).

/** The daemon-managed agent-facing CLI, as resolved for one spawn. */
export interface AgentCli {
	/** Absolute `.bin` dir to prepend to PATH, or null → use the ambient PATH. */
	binDir: string | null;
	/** Version of the resolved CLI, when it could be read. */
	version: string | null;
	/** How it was resolved: a fresh install, the last-good copy, or no prefix at all. */
	source: 'fresh' | 'stale' | 'ambient';
}

/** No daemon-managed CLI: the harness resolves `tines` from the ambient PATH. */
export const AMBIENT_CLI: AgentCli = { binDir: null, version: null, source: 'ambient' };

/**
 * TTL-gates and coalesces CLI refreshes: at most one install in flight (two
 * `npm i` into one prefix racing each other is the failure this prevents),
 * and at most one attempt per `ttlMs` — gated on *attempt*, not success, so
 * an offline machine does not pay the install timeout on every launch.
 * `install` is the I/O effect (cli-refresh.ts); this is the policy around it.
 */
export class CliRefresher {
	private cached: AgentCli = AMBIENT_CLI;
	private lastAttempt: number | null = null;
	private inFlight: Promise<AgentCli> | null = null;

	constructor(
		private readonly install: () => Promise<AgentCli>,
		private readonly opts: { ttlMs?: number; now?: () => number } = {}
	) {}

	/** The current CLI, refreshing first when the TTL elapsed. Never rejects. */
	ensure(): Promise<AgentCli> {
		if (this.inFlight) return this.inFlight;
		const now = (this.opts.now ?? Date.now)();
		if (this.lastAttempt !== null && now - this.lastAttempt < (this.opts.ttlMs ?? 10 * 60_000)) {
			return Promise.resolve(this.cached);
		}
		this.lastAttempt = now;
		// A throwing install is a bug, not a failure mode — but it must still
		// never fail a launch, so it degrades to the ambient PATH.
		this.inFlight = Promise.resolve()
			.then(() => this.install())
			.catch(() => AMBIENT_CLI)
			.then((cli) => {
				this.cached = cli;
				this.inFlight = null;
				return cli;
			});
		return this.inFlight;
	}
}

/**
 * The harness spawn environment: the daemon's own environment plus the run's
 * key and API base, with the managed CLI's bin dir prepended to PATH when
 * there is one — so `tines` inside the run resolves to the daemon-managed
 * copy, and everything else on the machine is untouched.
 */
export function buildSpawnEnv(
	base: NodeJS.ProcessEnv,
	opts: { binDir: string | null; apiKey: string; apiUrl: string }
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...base,
		TINES_API_KEY: opts.apiKey,
		TINES_API_URL: opts.apiUrl
	};
	if (opts.binDir) env.PATH = base.PATH ? `${opts.binDir}${delimiter}${base.PATH}` : opts.binDir;
	return env;
}
