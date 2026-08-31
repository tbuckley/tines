/**
 * Pure daemon logic — harness invocation building, command-template
 * expansion, and log-chunk batching — kept free of I/O so it is
 * unit-testable without a daemon (see support.test.ts). The loop itself
 * lives in daemon.ts.
 */

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
			// stream-json (which requires --verbose under -p) is what makes a
			// local run's log worth keeping: plain `claude -p` prints only the
			// final assistant message, so the log was the daemon's own setup
			// lines, silence for the whole run, then one blob. The daemon
			// renders the stream to readable lines (claude-stream.ts).
			return {
				file: 'sh',
				args: [
					'-c',
					`claude -p --output-format stream-json --verbose${input.model ? ` --model ${shellQuote(input.model)}` : ''} < ${shellQuote(input.promptFile)}`
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
	/**
	 * Turns whatever the harness said after its last newline into a log line,
	 * so a harness killed mid-line does not lose its final words. Runs before
	 * `flush`, and is idempotent. */
	drain?: () => void;
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
		// Before the flush, not after: a line appended afterwards would sit in
		// the batcher until its timer fired, by which point the run is
		// finish-reported and the append is rejected.
		run.drain?.();
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
	/**
	 * Flush as soon as the buffer reaches this many bytes. Default 32 KB —
	 * every chunk past the tail's cap becomes an object in the run-log
	 * bucket, and a larger batch means proportionally fewer of them. The
	 * interval keeps the live tail responsive regardless.
	 */
	maxBytes?: number;
	/** Flush at most this long after the first unflushed byte. Default 2 s. */
	intervalMs?: number;
	/** Send failures land here (default: swallowed). */
	onError?: (err: unknown) => void;
	/**
	 * Beyond this many bytes of unsent backlog, the oldest are dropped with a
	 * marker rather than growing without bound. Default 1 MiB.
	 */
	maxPendingBytes?: number;
}

/**
 * Batches harness output into log-append chunks: a chunk is sent when the
 * buffer reaches `maxBytes`, or `intervalMs` after output first arrived —
 * so a chatty harness doesn't produce a request per line and a quiet one
 * still streams promptly. Sends are serialized (chunks arrive in order).
 *
 * A failed send is retried on the next flush rather than dropped: with the
 * full log now durable, silently losing a chunk would put a hole in it. Each
 * chunk carries a monotonic `seq`, so a retry of a send whose response was
 * lost is recognised server-side and applied exactly once.
 */
export class LogBatcher {
	private buffer = '';
	private timer: ReturnType<typeof setTimeout> | null = null;
	private sending: Promise<void> = Promise.resolve();
	private seq = 0;
	/** Chunks awaiting a successful send, oldest first. */
	private pending: { chunk: string; seq: number }[] = [];

	constructor(
		private readonly send: (chunk: string, seq: number) => Promise<void>,
		private readonly opts: LogBatcherOptions = {}
	) {}

	append(text: string): void {
		if (!text) return;
		this.buffer += text;
		if (Buffer.byteLength(this.buffer, 'utf8') >= (this.opts.maxBytes ?? 32 * 1024)) {
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
		if (this.buffer) {
			this.pending.push({ chunk: this.buffer, seq: ++this.seq });
			this.buffer = '';
			this.trimPending();
		}
		if (this.pending.length === 0) return this.sending;
		this.sending = this.sending.then(() => this.drain());
		return this.sending;
	}

	/**
	 * Sends queued chunks in order, stopping at the first failure so the
	 * survivors keep their place — and their seq, which is what lets the
	 * server recognise a resend of a chunk it already applied.
	 */
	private async drain(): Promise<void> {
		while (this.pending.length > 0) {
			const next = this.pending[0]!;
			try {
				await this.send(next.chunk, next.seq);
			} catch (err) {
				this.opts.onError?.(err);
				return;
			}
			this.pending.shift();
		}
	}

	/**
	 * Bounds the retry backlog: a daemon that cannot reach the supervisor for
	 * a long time must not grow its heap without limit. The oldest chunks go
	 * first, with a marker so the gap is visible in the log rather than
	 * silent.
	 */
	private trimPending(): void {
		const cap = this.opts.maxPendingBytes ?? 1024 * 1024;
		let held = this.pending.reduce((n, p) => n + Buffer.byteLength(p.chunk, 'utf8'), 0);
		if (held <= cap) return;
		let lost = 0;
		while (this.pending.length > 1 && held > cap) {
			const dropped = this.pending.shift()!;
			const bytes = Buffer.byteLength(dropped.chunk, 'utf8');
			held -= bytes;
			lost += bytes;
		}
		const head = this.pending[0]!;
		head.chunk = `[log] ${lost} bytes lost (supervisor unreachable)\n${head.chunk}`;
	}
}
