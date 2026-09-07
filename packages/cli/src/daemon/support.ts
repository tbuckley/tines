/**
 * Pure daemon logic — harness invocation building, command-template
 * expansion, and log-chunk batching — kept free of I/O so it is
 * unit-testable without a daemon (see support.test.ts). The loop itself
 * lives in daemon.ts.
 */
import { delimiter, sep } from 'node:path';

export type HarnessKind = 'claude_code' | 'codex' | 'custom';

export const HARNESS_KINDS: readonly HarnessKind[] = ['claude_code', 'codex', 'custom'];

/** `--keep-workspaces`: which settled runs leave their workspace on disk. */
export type KeepWorkspacesMode = 'never' | 'failed' | 'always';

export const KEEP_WORKSPACES_MODES: readonly KeepWorkspacesMode[] = ['never', 'failed', 'always'];

/** How a run ended, as far as the workspace decision is concerned. */
export type RunOutcome = 'completed' | 'failed';

/**
 * Whether a settling run's workspace survives. Pure, so the daemon's flag and
 * the state machine's decision are the same one function (see keptMarker in
 * store.ts for what is written into a kept workspace).
 */
export function keepWorkspace(mode: KeepWorkspacesMode, outcome: RunOutcome): boolean {
	return mode === 'always' || (mode === 'failed' && outcome === 'failed');
}

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
			// --skip-git-repo-check is required to treat the folder as trusted
			return {
				file: 'codex',
				args: ['exec', '--skip-git-repo-check', ...(input.model ? ['--model', input.model] : []), input.prompt]
			};
		case 'custom': {
			if (!spec.command) throw new Error('the custom harness needs a --command template');
			return { file: 'sh', args: ['-c', expandCommandTemplate(spec.command, input)] };
		}
	}
}

// ---------------------------------------------------------------------------
// The launch banner: what the daemon actually ran, in the run's own log.
// Without it a run log jumps from the git clones straight into harness output,
// and "which model / which timeout / which expanded --command?" is answerable
// only from the daemon's console — which a service manager swallows.

/** Longest argv word rendered verbatim in the launch line; the rest is elided. */
const LAUNCH_ARG_MAX = 160;

/** Words a POSIX shell needs no quoting for; keeps the line readable. */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * One argv word for the launch line: quoted only where a shell would need it,
 * and elided past LAUNCH_ARG_MAX — codex takes the whole stitched prompt on
 * argv, and a 25 KB log line helps nobody (the workspace's prompt.md, and the
 * run record, still have it whole).
 */
function launchWord(word: string): string {
	if (word.length > LAUNCH_ARG_MAX)
		return shellQuote(`${word.slice(0, LAUNCH_ARG_MAX)}… [+${word.length - LAUNCH_ARG_MAX} chars]`);
	return SAFE_WORD.test(word) ? word : shellQuote(word);
}

/**
 * The invocation as a shell line. `sh -c <script>` harnesses (claude_code, a
 * custom template) render the script itself — already expanded, exactly what
 * the shell was handed — and everything else renders its argv shell-quoted.
 */
export function formatLaunchCommand(invocation: HarnessInvocation): string {
	if (invocation.file === 'sh' && invocation.args.length === 2 && invocation.args[0] === '-c')
		return invocation.args[1]!;
	return [invocation.file, ...invocation.args].map(launchWord).join(' ');
}

export interface LaunchMeta {
	harness: HarnessKind;
	/** Minutes before the daemon kills the harness (the assignment's). */
	timeoutMinutes: number;
	/** The daemon's own version — the `tines` running the loop, not the agent's. */
	cliVersion: string;
}

/**
 * The two-line block appended to the run log immediately before the spawn:
 * the command in the same `$ …` convention as the git clones, then a `#`
 * metadata line. The run key is deliberately absent — it lives in the spawn
 * environment (buildSpawnEnv), never in argv, and this renders argv.
 */
export function formatLaunchBanner(
	invocation: HarnessInvocation,
	input: HarnessInput,
	meta: LaunchMeta
): string {
	const fields = [
		`harness=${meta.harness}`,
		`model=${input.model ?? '(fixed)'}`,
		`timeout=${meta.timeoutMinutes}m`,
		`cli=${meta.cliVersion}`,
		`workspace=${input.workspace}`
	];
	return `$ ${formatLaunchCommand(invocation)}\n# tines runner: ${fields.join(' ')}\n`;
}

export interface HarnessExit {
	/** Exit code, or null when a signal took it. */
	code: number | null;
	/** The signal that killed it, if any. */
	signal: NodeJS.Signals | null;
	/** Wall clock from spawn to exit. */
	durationMs: number;
	/** The daemon's own timeout fired — the signal above is the daemon's. */
	timedOut?: boolean;
}

/** `<m>m<s>s` — minutes never roll into hours; a run's timeout is in minutes. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/**
 * The closing line, so a run log is self-describing end to end without the
 * run record beside it. The finish report still carries the authoritative
 * reason; this is the log's own account of how the harness ended.
 */
export function formatExitLine(exit: HarnessExit): string {
	const parts: string[] = [];
	if (exit.code !== null) parts.push(`code=${exit.code}`);
	if (exit.signal) parts.push(`signal=${exit.signal}`);
	if (parts.length === 0) parts.push('code=?');
	if (exit.timedOut) parts.push('(timed out)');
	return `# tines runner: exit ${parts.join(' ')} after ${formatDuration(exit.durationMs)}\n`;
}

/**
 * The closing line for a run whose harness just exited, or null when nobody
 * would read it: a supervisor-canceled run is already settled, takes
 * `finishAndCleanup`'s cleanup-only path, and so never flushes its batcher
 * again — the line would only sit there unsent.
 */
export function exitLineForRun(
	run: Pick<ManagedRun, 'settled' | 'timedOut'>,
	exit: Omit<HarnessExit, 'timedOut'>
): string | null {
	if (run.settled) return null;
	return formatExitLine({ ...exit, timedOut: run.timedOut });
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
	/**
	 * Why this run ended, in human words — recorded in a kept workspace's
	 * marker. Set by whoever settles it; the finish paths use their error text.
	 */
	endNote?: string;
	/** Drains pending log chunks before a finish report. */
	flush?: () => Promise<void>;
	/**
	 * Turns whatever the harness said after its last newline into a log line,
	 * so a harness killed mid-line does not lose its final words. Runs before
	 * `flush`, and is idempotent. */
	drain?: () => void;
}

/** What `release` is being asked to do with a settling run's workspace. */
export interface RunDisposition {
	keep: boolean;
	outcome: RunOutcome;
}

export interface RunTableEffects<T extends ManagedRun> {
	/**
	 * Report the finish to the supervisor; rejections are the caller-side log.
	 * `judgment` is set only on the ends this daemon caused itself — its own
	 * shutdown, an orphan killed after a restart — so the supervisor knows not
	 * to charge the issue for them.
	 */
	finish(
		run: T,
		status: 'completed' | 'failed',
		error?: string,
		judgment?: 'interrupted'
	): Promise<void>;
	/**
	 * Tear down the run's local traces: timers, and the workspace unless the
	 * disposition says to keep it (idempotent).
	 */
	release(run: T, disposition: RunDisposition): void;
	/**
	 * Announce a kept workspace in the run's own log. Called between `drain`
	 * and `flush`, the only window in which an appended line still ships.
	 */
	noteKept?(run: T): void;
	/** Persist the run → pid state file (membership or pid changed). */
	persist(): void;
	log(message: string): void;
}

export class RunTable<T extends ManagedRun> {
	private readonly runs = new Map<string, T>();

	/** The daemon's keep decision, as data: `keepWorkspace` bound to its mode. */
	private readonly keep: (outcome: RunOutcome) => boolean;

	constructor(
		private readonly effects: RunTableEffects<T>,
		opts: { keep?: (outcome: RunOutcome) => boolean } = {}
	) {
		// Default: today's behaviour, so a caller that passes no decision keeps
		// nothing.
		this.keep = opts.keep ?? (() => false);
	}

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

	/**
	 * Removes the run and releases its local traces. Safe to call twice.
	 *
	 * The outcome defaults to `failed` because every route here that is not an
	 * explicit completed finish is a failure: a supervisor cancel (which
	 * reaches cleanup with no status at all), a clone failure on an
	 * already-settled run, a daemon shutdown. Guessing `failed` also errs the
	 * safe way — it keeps a directory rather than destroying evidence.
	 */
	cleanup(run: T, outcome: RunOutcome = 'failed'): void {
		this.runs.delete(run.runId);
		this.effects.persist();
		this.effects.release(run, { keep: this.keep(outcome), outcome });
	}

	/**
	 * Ends a run: flush logs, finish-report, clean up. On a run someone
	 * already settled (a poll-cancel racing a clone failure or spawn error)
	 * this still cleans up — the slot, workspace, and state entry must never
	 * outlive the run — but reports nothing.
	 *
	 * Pass `judgment: 'interrupted'` when the daemon itself ended the run
	 * (shutdown, restart) rather than the work failing: the supervisor then
	 * spares the issue a strike. Everything a run can do wrong to itself —
	 * a non-zero harness exit, a workspace that would not set up — must not
	 * set it.
	 */
	async finishAndCleanup(
		run: T,
		status: 'completed' | 'failed',
		error?: string,
		judgment?: 'interrupted'
	): Promise<void> {
		if (run.settled) return this.cleanup(run);
		run.settled = true;
		run.endNote ??= error;
		// Before the flush, not after: a line appended afterwards would sit in
		// the batcher until its timer fired, by which point the run is
		// finish-reported and the append is rejected.
		run.drain?.();
		if (this.keep(status)) this.effects.noteKept?.(run);
		await run.flush?.();
		try {
			await this.effects.finish(run, status, error, judgment);
			this.effects.log(`run ${run.runId} finished: ${status}${error ? ` (${error})` : ''}`);
		} catch (err) {
			// A settled run (canceled/timed out/swept server-side) is fine; the
			// supervisor's word stands.
			this.effects.log(
				`finish report for run ${run.runId} not accepted: ${err instanceof Error ? err.message : String(err)}`
			);
		}
		this.cleanup(run, status);
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

	/**
	 * Resolves once no install is in flight, starting none. A daemon about to
	 * exit for a self-update waits on this so it never restarts into a
	 * half-extracted prefix.
	 */
	settled(): Promise<void> {
		return this.inFlight ? this.inFlight.then(() => undefined) : Promise.resolve();
	}

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

// ---------------------------------------------------------------------------
// Self-update: the refresh above keeps a current `tines` on disk, and a daemon
// launched from that same prefix is running an older copy of it. It cannot
// replace itself in place; it drains and exits for the service manager to
// relaunch (daemon.ts). These are the decisions, kept pure.

/**
 * Whether `candidate` is a strictly newer release than `current`: dotted
 * numeric parts compared left to right, a missing part counting as 0.
 * Anything that is not plain dotted digits — a prerelease tag, the
 * `0.0.0-unknown` an unreadable manifest yields — is never newer, so an
 * unreadable version can never trigger a restart.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
	const parse = (v: string): number[] | null =>
		/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null;
	const a = parse(candidate);
	const b = parse(current);
	if (!a || !b) return false;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		if (x !== y) return x > y;
	}
	return false;
}

/**
 * The version a self-update would restart into, or null when the resolved
 * CLI is not a newer daemon: the ambient PATH (nothing was installed), an
 * unreadable version, or one no newer than `running`. A last-good (`stale`)
 * copy counts — an earlier refresh installed it and it is what a relaunch
 * would run.
 */
export function pendingSelfUpdate(cli: AgentCli, running: string): string | null {
	if (cli.source === 'ambient' || !cli.version) return null;
	return isNewerVersion(cli.version, running) ? cli.version : null;
}

/**
 * Whether `path` lies inside `dir` (both already resolved: no symlinks, no
 * `..`). A prefix string match alone would let `/cfg/cli-old/x` pass for
 * `/cfg/cli`, so the boundary must fall on a separator.
 */
export function pathWithin(path: string, dir: string): boolean {
	const root = dir.endsWith(sep) ? dir : dir + sep;
	return path.startsWith(root);
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
