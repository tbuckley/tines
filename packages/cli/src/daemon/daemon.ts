/**
 * `tines runner daemon`: the local runner. Registers (or reconnects) with
 * the supervisor, polls for assigned runs, materializes each run's
 * workspace (the `issues context --out` layout), clones its repos with the
 * device's own git credentials, launches the harness with the run key in
 * its environment, streams output as log chunks, kills on cancel/timeout,
 * reports finishes, and cleans up — surviving its own crashes via the state
 * file (orphan kill on restart) and the supervisor's `owned_runs`/offline
 * reconciliation (SPEC.md "Local runner protocol"). Run bookkeeping (the
 * settle/cleanup state machine) lives in support.ts's RunTable so it is
 * unit-testable.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	type WriteStream
} from 'node:fs';
import { hostname, platform, arch } from 'node:os';
import { dirname, join } from 'node:path';
import { ApiError, RUN_LOG_RAW_MAX_BYTES, createApiClient, type RunnerAssignment } from '@tines/shared';
import { cliVersion } from '../version.js';
import { ClaudeStreamRenderer } from './claude-stream';
import { installAgentCli } from './cli-refresh.js';
import {
	clearRunnerCredentials,
	daemonStatePath,
	loadDaemonState,
	loadRunnerCredentials,
	processStartTimeMs,
	pruneKeptWorkspaces,
	saveDaemonState,
	saveRunnerCredentials,
	workspacesDir,
	writeKeptMarker,
	type DaemonStateEntry,
	type KeptWorkspaceMarker,
	type RunnerCredentials
} from './store.js';
import {
	AMBIENT_CLI,
	buildHarnessInvocation,
	buildSpawnEnv,
	CliRefresher,
	exitLineForRun,
	formatLaunchBanner,
	keepWorkspace,
	LogBatcher,
	RunTable,
	type AgentCli,
	type HarnessKind,
	type KeepWorkspacesMode,
	type ManagedRun
} from './support.js';

export interface DaemonOptions {
	url: string;
	/** User API key — only needed for first registration (or re-registration). */
	apiKey?: string;
	name: string;
	harness: HarnessKind;
	command?: string;
	maxConcurrent: number;
	pollIntervalMs: number;
	configDir: string;
	/** Keep the agent-facing `tines` current from npm (--no-cli-refresh turns it off). */
	cliRefresh: boolean;
	/** Which settled runs leave their workspace on disk for debugging. */
	keepWorkspaces: KeepWorkspacesMode;
	/** Retention window for kept workspaces, in hours. */
	keepWorkspacesForHours: number;
	/** At most this many kept workspaces survive a sweep; oldest go first. */
	keepWorkspacesMax: number;
}

/** How often a launch may re-attempt the CLI refresh (gated on attempt, not success). */
const CLI_REFRESH_TTL_MS = 10 * 60_000;

/** This daemon's own version, stamped into every run's launch banner. */
const DAEMON_VERSION = cliVersion();

interface ActiveRun extends ManagedRun {
	child?: ChildProcess;
	batcher: LogBatcher;
	timeout?: ReturnType<typeof setTimeout>;
	keyFingerprint: string;
	spawnedAt?: number;
	/** `Project/123` — recorded in a kept workspace and the state file. */
	issueLabel?: string;
	/** claude_code: NDJSON → readable lines for the log (claude-stream.ts). */
	renderer?: ClaudeStreamRenderer;
	/** claude_code: the unrendered stream, spooled for the raw-log upload. */
	rawSpool?: WriteStream;
	/** Where that spool lives — outside the workspace, which release() wipes. */
	rawSpoolPath?: string;
	/** Bound uploader for that spool (needs the client, which release lacks). */
	rawUpload?: (body: Uint8Array) => Promise<unknown>;
}

/**
 * Uploads a claude_code run's unrendered NDJSON stream, then deletes the
 * spool. Best-effort throughout: the rendered log is already durable, and a
 * failure here costs the raw copy, not the run.
 */
async function uploadRawLog(run: {
	runId: string;
	rawSpool?: WriteStream;
	rawSpoolPath?: string;
	rawUpload?: (body: Uint8Array) => Promise<unknown>;
}): Promise<void> {
	const path = run.rawSpoolPath;
	if (!path || !run.rawUpload) return;
	run.rawSpoolPath = undefined;
	try {
		await new Promise<void>((resolve) => run.rawSpool?.end(resolve) ?? resolve());
		const size = statSync(path).size;
		if (size > 0) {
			// Read whole, not streamed: the server side streams into R2, but
			// the client holds up to RUN_LOG_RAW_MAX_BYTES here (briefly twice
			// that on the truncation path's copy). That is the daemon, not a
			// Worker, and the run has already been finish-reported by now — if
			// the cap ever grows, stream this and send the length explicitly.
			let body = readFileSync(path);
			if (body.byteLength > RUN_LOG_RAW_MAX_BYTES) {
				// Keep the tail — the end of a stream is where the failure is —
				// and say so, rather than sending a body the server will reject.
				const marker = Buffer.from(
					`{"type":"tines_truncated","dropped_bytes":${body.byteLength - RUN_LOG_RAW_MAX_BYTES}}\n`
				);
				body = Buffer.concat([marker, body.subarray(body.byteLength - RUN_LOG_RAW_MAX_BYTES + marker.byteLength)]);
			}
			await run.rawUpload(body);
		}
	} catch {
		// Swallowed: see the doc comment.
	} finally {
		try {
			unlinkSync(path);
		} catch {
			// Already gone.
		}
	}
}

const log = (message: string) =>
	console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function killTree(pid: number, signal: NodeJS.Signals): void {
	// The harness is spawned detached (its own process group), so children —
	// a custom template's `sh -c` pipeline, tools the agent spawned — die too.
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function runDaemon(opts: DaemonOptions): Promise<void> {
	mkdirSync(opts.configDir, { recursive: true });
	// A workspace holds cloned repositories and whatever the agent wrote, so
	// the directory they share is created user-only. (The mode applies at
	// creation; an existing directory keeps whatever permissions it has.)
	mkdirSync(workspacesDir(opts.configDir), { recursive: true, mode: 0o700 });

	// Kept workspaces (--keep-workspaces) are bounded by age and by count: one
	// can reach hundreds of megabytes once its agent installed dependencies.
	// The sweep runs regardless of the current mode, so going back to `never`
	// still reaps what an earlier run kept, and it only ever touches
	// directories holding a kept.json — never a live run's bare workspace.
	const sweepKeptWorkspaces = () => {
		const removed = pruneKeptWorkspaces(opts.configDir, {
			maxAgeMs: opts.keepWorkspacesForHours * 3600_000,
			maxCount: opts.keepWorkspacesMax
		});
		if (removed.length > 0) {
			log(
				`pruned ${removed.length} kept workspace(s) past retention (${opts.keepWorkspacesForHours}h, max ${opts.keepWorkspacesMax})`
			);
		}
	};
	sweepKeptWorkspaces();

	/**
	 * The workspace half of settling a run: removed, or kept and marked with a
	 * kept.json saying what it was. A marker that cannot be written leaves the
	 * directory in place regardless — unmarked, so no sweep will ever reap it,
	 * which is the safe direction for evidence.
	 */
	const settleWorkspace = (
		workspace: string,
		keep: boolean,
		marker: Omit<KeptWorkspaceMarker, 'kept_at'>
	): void => {
		if (!keep) {
			rmSync(workspace, { recursive: true, force: true });
			return;
		}
		// Cleanup is idempotent by contract: a second release must not
		// resurrect a removed workspace as an empty kept one.
		if (!existsSync(workspace)) return;
		try {
			writeKeptMarker(workspace, { ...marker, kept_at: new Date().toISOString() });
			log(`run ${marker.run_id}: workspace kept at ${workspace}`);
		} catch (err) {
			log(
				`run ${marker.run_id}: workspace kept at ${workspace}, but kept.json could not be written (${message(err)})`
			);
		}
	};

	// -- registration / reconnect ---------------------------------------------
	let creds: RunnerCredentials | null = loadRunnerCredentials(opts.configDir, opts.url, opts.name);
	if (creds) {
		log(`reconnecting as runner "${opts.name}" (${creds.runner_id}) — token from ${opts.configDir}`);
	} else {
		if (!opts.apiKey) {
			throw new Error(
				`no stored runner token for "${opts.name}" at ${opts.url} — set TINES_API_KEY (a user API key) to register`
			);
		}
		const userClient = createApiClient({ baseUrl: opts.url, apiKey: opts.apiKey });
		const registered = await userClient.registerRunner({
			name: opts.name,
			harness: opts.harness,
			...(opts.command !== undefined ? { command: opts.command } : {}),
			max_concurrent: opts.maxConcurrent,
			hostname: hostname(),
			platform: `${platform()} ${arch()}`
		});
		creds = { runner_id: registered.runner.id, token: registered.runner_token };
		saveRunnerCredentials(opts.configDir, opts.url, opts.name, creds);
		log(`registered runner "${opts.name}" (${creds.runner_id}); token stored in ${opts.configDir}`);
	}

	const client = createApiClient({ baseUrl: opts.url, apiKey: creds.token });
	const statePath = daemonStatePath(opts.configDir, creds.runner_id);
	let shuttingDown = false;

	// -- the agent-facing CLI -------------------------------------------------
	// The launch prompt is always current (it deploys on every merge); the
	// `tines` an agent resolves must be too, or it silently misreads commands
	// the prompt teaches. The daemon keeps its own copy and injects it into
	// the harness PATH — the machine's global install is never touched.
	const refresher = new CliRefresher(() => installAgentCli({ configDir: opts.configDir, log }), {
		ttlMs: CLI_REFRESH_TTL_MS
	});
	const ensureCli = (): Promise<AgentCli> =>
		opts.cliRefresh ? refresher.ensure() : Promise.resolve(AMBIENT_CLI);
	const cliLabel = (cli: AgentCli) =>
		cli.source === 'ambient'
			? `ambient PATH (${opts.cliRefresh ? 'refresh failed' : 'refresh disabled'})`
			: `tines ${cli.version ?? 'unknown'} (daemon-managed${cli.source === 'stale' ? ', last-good copy' : ''})`;
	log(`agent CLI: ${cliLabel(await ensureCli())}`);

	const table: RunTable<ActiveRun> = new RunTable<ActiveRun>({
		finish: async (run, status, error) => {
			await client.finishRun(run.runId, { status, ...(error ? { error } : {}) });
		},
		release: (run, { keep, outcome }) => {
			if (run.timeout) clearTimeout(run.timeout);
			// `finishAndCleanup` already drained (before its flush, so the line
			// actually ships). This is the backstop for the paths that reach
			// cleanup without finishing — an already-settled run, a clone
			// failure — where the renderer must not be left holding a line.
			// `finish()` is idempotent, so the double call is free.
			run.renderer?.finish();
			settleWorkspace(run.workspace, keep, {
				run_id: run.runId,
				...(run.issueLabel ? { issue_ref: run.issueLabel } : {}),
				status: outcome,
				...(run.endNote ? { error: run.endNote } : {})
			});
			// Deliberately after cleanup and not awaited: the raw log is a
			// forensic extra, and a slow or failed upload must not hold a
			// concurrency slot. The spool lives outside the workspace, so the
			// rmSync above did not take it.
			void uploadRawLog(run);
			sweepKeptWorkspaces();
		},
		noteKept: (run) => run.batcher.append(`workspace kept at ${run.workspace}\n`),
		persist: () => {
			const entries: DaemonStateEntry[] = table
				.values()
				.filter((run) => run.child?.pid !== undefined)
				.map((run) => ({
					run_id: run.runId,
					pid: run.child!.pid!,
					workspace: run.workspace,
					key_fingerprint: run.keyFingerprint,
					started_at: run.spawnedAt,
					...(run.issueLabel ? { issue_ref: run.issueLabel } : {})
				}));
			saveDaemonState(statePath, entries);
		},
		log
	}, { keep: (outcome) => keepWorkspace(opts.keepWorkspaces, outcome) });

	// -- orphan cleanup: a crashed daemon must not leave a zombie harness -----
	for (const orphan of loadDaemonState(statePath)) {
		// Kill only a pid that is (a) still alive and (b), where the platform
		// lets us check cheaply, actually started around when we spawned it —
		// a recycled pid must not take out an innocent process. The residual
		// window (non-Linux platforms, or reuse faster than the clock slack)
		// is accepted: the state file is fresh in practice, and pid reuse
		// within it is vanishingly rare.
		if (pidAlive(orphan.pid)) {
			const processStart = processStartTimeMs(orphan.pid);
			const reused =
				processStart !== null &&
				orphan.started_at !== undefined &&
				processStart > orphan.started_at + 60_000;
			if (reused) {
				log(`state-file pid ${orphan.pid} (run ${orphan.run_id}) was recycled; not killing it`);
			} else {
				log(`killing orphaned harness from a previous life: run ${orphan.run_id} (pid ${orphan.pid})`);
				killTree(orphan.pid, 'SIGKILL');
			}
		}
		try {
			await client.finishRun(orphan.run_id, {
				status: 'failed',
				error: 'daemon restarted; orphaned harness killed'
			});
		} catch {
			// Already settled by the supervisor (cancel/timeout/offline sweep).
		}
		// No run-log line here: an orphan's run may already be settled
		// server-side, where an append is rejected. The daemon's own log and
		// the kept.json are the record.
		settleWorkspace(orphan.workspace, keepWorkspace(opts.keepWorkspaces, 'failed'), {
			run_id: orphan.run_id,
			...(orphan.issue_ref ? { issue_ref: orphan.issue_ref } : {}),
			status: 'failed',
			error: 'daemon restarted; orphaned harness killed'
		});
	}
	saveDaemonState(statePath, []);

	const killWithoutFinish = (runId: string) => {
		const run = table.markCanceled(runId);
		if (!run) return;
		run.endNote ??= 'canceled by supervisor';
		log(`supervisor canceled run ${runId}; killing without finish-reporting`);
		if (run.child?.pid) {
			const pid = run.child.pid;
			killTree(pid, 'SIGTERM');
			setTimeout(() => killTree(pid, 'SIGKILL'), 5000).unref?.();
			// The exit handler does the cleanup once the process dies.
		}
		// No process yet (still materializing): the launch path's settled
		// checks clean up.
	};

	// -- launching one assignment ---------------------------------------------
	const launch = async (assignment: RunnerAssignment) => {
		const runId = assignment.run.id;
		if (table.has(runId)) return;
		const workspace = join(workspacesDir(opts.configDir), runId);
		const issueLabel = assignment.run.issue_ref
			? `${assignment.run.issue_ref.project_name}/${assignment.run.issue_ref.number}`
			: undefined;
		const run: ActiveRun = {
			runId,
			workspace,
			...(issueLabel ? { issueLabel } : {}),
			canceled: false,
			timedOut: false,
			settled: false,
			keyFingerprint: assignment.run_key.slice(0, 14),
			batcher: new LogBatcher(
				(chunk, seq) => client.appendRunLog(runId, { chunk, seq }).then(() => {}),
				{ onError: (err) => log(`log append for run ${runId} failed: ${message(err)}`) }
			)
		};
		run.flush = () => run.batcher.flush();
		table.track(run);
		log(`run ${runId} assigned (issue ${issueLabel ?? assignment.run.issue_id}); materializing workspace`);

		try {
			// The workspace: exactly the `issues context --out` layout.
			rmSync(workspace, { recursive: true, force: true });
			mkdirSync(workspace, { recursive: true });
			writeFileSync(join(workspace, 'prompt.md'), `${assignment.prompt}\n`);
			for (const skill of assignment.bundle.skills) {
				for (const file of skill.files) {
					const target = join(workspace, 'skills', skill.name, file.path);
					mkdirSync(dirname(target), { recursive: true });
					writeFileSync(target, file.content);
				}
			}
			writeFileSync(
				join(workspace, 'repos.json'),
				`${JSON.stringify(assignment.bundle.repos, null, 2)}\n`
			);

			// Clone the effective repos with the device's own git credentials.
			for (const repo of assignment.bundle.repos) {
				if (run.settled) return table.cleanup(run);
				const args = ['clone', ...(repo.branch ? ['--branch', repo.branch] : []), repo.url, repo.dir];
				run.batcher.append(`$ git ${args.join(' ')}\n`);
				const result = await runGit(args, workspace, run.batcher);
				if (result !== 0) {
					return table.finishAndCleanup(run, 'failed', `git clone failed for ${repo.url} (exit ${result})`);
				}
			}
			if (run.settled) return table.cleanup(run);

			// Refreshed after the clones, so a TTL-expired install overlaps
			// nothing the run is waiting on; the result is recorded in the run's
			// own log, which is where a confused agent's reader looks first.
			const cli = await ensureCli();
			if (run.settled) return table.cleanup(run);
			run.batcher.append(
				cli.source === 'fresh'
					? `tines CLI: ${cli.version ?? 'unknown'} (daemon-managed)\n`
					: cli.source === 'stale'
						? `warning: agent CLI refresh failed; using last-good tines ${cli.version ?? 'unknown'} from ${opts.configDir}/cli\n`
						: `warning: no daemon-managed tines CLI; using whatever \`tines\` is on this machine's PATH\n`
			);

			const harnessInput = {
				workspace,
				promptFile: join(workspace, 'prompt.md'),
				prompt: assignment.prompt,
				model: assignment.run.model
			};
			const invocation = buildHarnessInvocation(
				{ harness: opts.harness, command: opts.command },
				harnessInput
			);
			// What we are about to run, in the log itself: a failed run is read
			// long after the daemon's console scrolled away (or was swallowed by
			// launchd), and "which model / which timeout / which expanded
			// --command?" is otherwise unanswerable from the run.
			run.batcher.append(
				formatLaunchBanner(invocation, harnessInput, {
					harness: opts.harness,
					timeoutMinutes: assignment.timeout_minutes,
					cliVersion: DAEMON_VERSION
				})
			);
			const child = spawn(invocation.file, invocation.args, {
				cwd: workspace,
				env: buildSpawnEnv(process.env, {
					binDir: cli.binDir,
					apiKey: assignment.run_key,
					apiUrl: opts.url
				}),
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: true
			});
			run.child = child;
			run.spawnedAt = Date.now();
			table.persist();
			log(`run ${runId}: launched ${invocation.file} (pid ${child.pid})`);

			if (opts.harness === 'claude_code') {
				// The harness speaks NDJSON now; the log the user reads is the
				// rendered form. The stream itself is spooled outside the
				// workspace (release() wipes that) and uploaded at settle, so
				// nothing the harness emitted is actually lost.
				const renderer = new ClaudeStreamRenderer((line) => run.batcher.append(line));
				run.renderer = renderer;
				run.drain = () => renderer.finish();
				const spoolPath = join(opts.configDir, 'rawlogs', `${runId}.ndjson`);
				mkdirSync(dirname(spoolPath), { recursive: true });
				run.rawSpoolPath = spoolPath;
				run.rawSpool = createWriteStream(spoolPath);
				run.rawUpload = (body) => client.putRunLogRaw(runId, body);
				child.stdout?.on('data', (data: Buffer) => {
					run.rawSpool?.write(data);
					renderer.write(data.toString('utf8'));
				});
			} else {
				child.stdout?.on('data', (data: Buffer) => run.batcher.append(data.toString('utf8')));
			}
			// stderr is never stream-json — it is the harness's own diagnostics,
			// and it goes to the log verbatim for every harness.
			child.stderr?.on('data', (data: Buffer) => run.batcher.append(data.toString('utf8')));
			run.timeout = setTimeout(
				() => {
					if (run.settled) return;
					log(`run ${runId} hit its ${assignment.timeout_minutes}m timeout; killing`);
					run.timedOut = true;
					if (child.pid) killTree(child.pid, 'SIGTERM');
					if (child.pid) setTimeout(() => killTree(child.pid!, 'SIGKILL'), 5000).unref?.();
				},
				assignment.timeout_minutes * 60_000
			);
			child.on('error', (err) => {
				void table.finishAndCleanup(run, 'failed', `failed to launch harness: ${message(err)}`);
			});
			child.on('exit', (code, signal) => {
				// The harness's last words first — a stream renderer holding a
				// partial line emits it here (drain is idempotent, and
				// finishAndCleanup calls it too), so the closing line below is
				// really the log's last.
				run.drain?.();
				const closing = exitLineForRun(run, {
					code,
					signal,
					durationMs: Date.now() - (run.spawnedAt ?? Date.now())
				});
				if (closing) run.batcher.append(closing);
				// A supervisor-canceled run is already settled: finishAndCleanup
				// degrades to cleanup-only, reporting nothing.
				if (run.timedOut) {
					void table.finishAndCleanup(
						run,
						'failed',
						`run exceeded the ${assignment.timeout_minutes}m timeout; harness killed`
					);
				} else if (code === 0) {
					void table.finishAndCleanup(run, 'completed');
				} else {
					void table.finishAndCleanup(
						run,
						'failed',
						signal ? `harness killed by ${signal}` : `harness exited with code ${code}`
					);
				}
			});
		} catch (err) {
			void table.finishAndCleanup(run, 'failed', `workspace setup failed: ${message(err)}`);
		}
	};

	// -- graceful shutdown: finish-fail in-flight runs before exiting ---------
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		log('shutting down; failing in-flight runs');
		await Promise.all(
			table.values().map(async (run) => {
				if (run.child?.pid) killTree(run.child.pid, 'SIGTERM');
				await table.finishAndCleanup(run, 'failed', 'daemon shut down');
			})
		);
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown());
	process.on('SIGTERM', () => void shutdown());

	// -- the poll loop ---------------------------------------------------------
	log(
		`polling ${opts.url} every ${Math.round(opts.pollIntervalMs / 1000)}s (harness ${opts.harness}, max ${opts.maxConcurrent} concurrent) — Ctrl-C to stop`
	);
	let failures = 0;
	while (!shuttingDown) {
		try {
			// `max_concurrent` rides along so the server cap tracks the flag —
			// a restart with a new --max-concurrent takes effect without
			// re-registering.
			const res = await client.pollRunner(creds.runner_id, {
				owned_runs: table.ids(),
				max_concurrent: opts.maxConcurrent
			});
			failures = 0;
			for (const runId of res.cancels) killWithoutFinish(runId);
			for (const assignment of res.assignments) {
				// The server's guarded flip is the authority on capacity: a
				// delivered run already holds its claim and key, so dropping it
				// here would strand it as a mislabeled launch failure. Launch
				// anyway and flag the divergence.
				if (table.size >= opts.maxConcurrent) {
					log(
						`warning: supervisor delivered ${assignment.run.id} beyond --max-concurrent ${opts.maxConcurrent}; launching anyway (the server cap governs)`
					);
				}
				void launch(assignment);
			}
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				// The token was rotated (or the runner removed): exit with clear
				// instructions rather than spinning. Any in-flight harnesses are
				// killed — their runs are failed by the supervisor's offline rule.
				for (const run of table.values()) {
					if (run.child?.pid) killTree(run.child.pid, 'SIGKILL');
					settleWorkspace(run.workspace, keepWorkspace(opts.keepWorkspaces, 'failed'), {
						run_id: run.runId,
						...(run.issueLabel ? { issue_ref: run.issueLabel } : {}),
						status: 'failed',
						error: 'daemon token rejected'
					});
				}
				saveDaemonState(statePath, []);
				clearRunnerCredentials(opts.configDir, opts.url, opts.name);
				throw new Error(
					`the supervisor rejected this runner's token (was it rotated?) — the stored token was dropped; restart with the new token via \`tines runners rotate-token ${opts.name}\` on this machine, or with TINES_API_KEY set to re-register`
				);
			}
			failures += 1;
			log(`poll failed (${message(err)}); retrying with backoff`);
		}
		// Network errors back off (2× per consecutive failure, capped at 60s
		// or 5 polls' worth); the loop itself never crashes.
		const backoff = Math.min(
			opts.pollIntervalMs * 2 ** Math.min(failures, 3),
			Math.max(60_000, opts.pollIntervalMs * 5)
		);
		await sleep(failures > 0 ? backoff : opts.pollIntervalMs);
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Runs git with output streamed into the run log; resolves to the exit code. */
function runGit(args: string[], cwd: string, batcher: LogBatcher): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout?.on('data', (data: Buffer) => batcher.append(data.toString('utf8')));
		child.stderr?.on('data', (data: Buffer) => batcher.append(data.toString('utf8')));
		child.on('error', () => resolve(127));
		child.on('exit', (code) => resolve(code ?? 1));
	});
}
