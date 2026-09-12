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
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	type WriteStream
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
	ApiError,
	RUN_LOG_RAW_MAX_BYTES,
	createApiClient,
	type RunnerAssignment
} from '@tines/shared';
import { cliVersion } from '../version.js';
import { ClaudeStreamRenderer } from './claude-stream';
import { CodexStreamRenderer } from './codex-stream.js';
import type { RunStreamRenderer } from './stream-summary.js';
import { RateLimitDetector } from './rate-limit';
import { agentCliPrefix, installAgentCli } from './cli-refresh.js';
import { ensureRunnerCredentials, nextStepsMessage } from './register.js';
import {
	clearRunnerCredentials,
	daemonStatePath,
	loadDaemonState,
	processStartTimeMs,
	pruneKeptWorkspaces,
	saveDaemonState,
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
	pathWithin,
	pendingSelfUpdate,
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
	/**
	 * Exit, once idle, when the refresh installed a newer `tines` than this
	 * daemon — for the service manager to relaunch it (--no-self-update turns
	 * it off). Only acts when the daemon runs from the managed prefix.
	 */
	selfUpdate: boolean;
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
	/** Structured provider NDJSON → readable lines plus terminal accounting. */
	renderer?: RunStreamRenderer;
	/** claude_code: watches the stream and stderr for a provider usage limit. */
	limiter?: RateLimitDetector;
	/** claude_code: the unrendered stream, spooled for the raw-log upload. */
	rawSpool?: WriteStream;
	/** Where that spool lives — outside the workspace, which release() wipes. */
	rawSpoolPath?: string;
	/** Bound uploader for that spool (needs the client, which release lacks). */
	rawUpload?: (body: Uint8Array) => Promise<unknown>;
	/** Turns already in the conversation when this run resumed it. */
	priorTurns: number;
	/** Set from the finish response: the server retained this workspace. */
	keepForResume: boolean;
	/** Immutable facts used to qualify Codex's requested-model estimate. */
	pricingModel?: string | null;
	pricingSessionMode?: 'cold' | 'resumed';
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
				body = Buffer.concat([
					marker,
					body.subarray(body.byteLength - RUN_LOG_RAW_MAX_BYTES + marker.byteLength)
				]);
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
	const instanceId = randomUUID();
	const baseUrl = opts.url.replace(/\/+$/, '');
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
	// Shared with `tines runner install` (register.ts), so the service unit
	// and a foreground start resolve exactly the same identity.
	const ensured = await ensureRunnerCredentials({
		configDir: opts.configDir,
		baseUrl,
		name: opts.name,
		harness: opts.harness,
		...(opts.command !== undefined ? { command: opts.command } : {}),
		maxConcurrent: opts.maxConcurrent,
		...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
		log
	});
	const creds: RunnerCredentials = ensured.creds;
	if (ensured.registered) {
		log(nextStepsMessage(opts.name, baseUrl));
		log(
			`keep it running: \`tines runner install --name ${opts.name} --harness ${opts.harness.replaceAll('_', '-')}\` installs this runner as a launchd/systemd service that keeps itself updated (docs/runner-daemon.md)`
		);
	}

	const client = createApiClient({ baseUrl, apiKey: creds.token });
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

	// -- self-update ----------------------------------------------------------
	// That refresh also keeps a current *daemon* on disk — when this process
	// was launched from the same prefix, which is what the service-manager
	// units in docs/runner-daemon.md do. A newer install cannot replace a
	// running process, so the daemon drains (polls with `draining`, so the
	// dispatcher assigns it nothing new while runs it already holds finish)
	// and exits once idle for launchd/systemd to relaunch it. Launched from
	// anywhere else an exit would relaunch the same old binary, so there the
	// newer version is only reported.
	const prefix = agentCliPrefix(opts.configDir);
	const selfPath = realpathOrNull(process.argv[1]);
	// Both sides resolved: a config dir reached through a symlink must not
	// read as "not the prefix". (The prefix may not exist yet on a first run.)
	const managedInstall =
		selfPath !== null && pathWithin(selfPath, realpathOrNull(prefix) ?? prefix);
	const selfUpdate = opts.selfUpdate && opts.cliRefresh && managedInstall;
	if (opts.selfUpdate && opts.cliRefresh) {
		log(
			managedInstall
				? `self-update: on — this daemon (tines ${DAEMON_VERSION}) runs from ${prefix} and will restart once idle after a newer release is installed there`
				: `self-update: off — this daemon (tines ${DAEMON_VERSION}) runs from ${selfPath ?? process.argv[1] ?? '?'}, not ${prefix}; launch it from ${join(prefix, 'node_modules', '.bin', 'tines')} to have refreshes apply on restart — \`tines runner install --name ${opts.name} --harness ${opts.harness.replaceAll('_', '-')}\` sets that up as a service (docs/runner-daemon.md)`
		);
	}
	let pendingUpdate: string | null = null;
	const noteCli = (cli: AgentCli): AgentCli => {
		if (!selfUpdate || pendingUpdate) return cli;
		const newer = pendingSelfUpdate(cli, DAEMON_VERSION);
		if (newer) {
			pendingUpdate = newer;
			log(
				`tines ${newer} is installed in ${prefix} (this daemon is ${DAEMON_VERSION}); draining — no new runs accepted, restarting once the in-flight ones finish`
			);
		}
		return cli;
	};

	const ensureCli = (): Promise<AgentCli> =>
		opts.cliRefresh ? refresher.ensure().then(noteCli) : Promise.resolve(AMBIENT_CLI);
	const cliLabel = (cli: AgentCli) =>
		cli.source === 'ambient'
			? `ambient PATH (${opts.cliRefresh ? 'refresh failed' : 'refresh disabled'})`
			: `tines ${cli.version ?? 'unknown'} (daemon-managed${cli.source === 'stale' ? ', last-good copy' : ''})`;
	log(`agent CLI: ${cliLabel(await ensureCli())}`);

	const table: RunTable<ActiveRun> = new RunTable<ActiveRun>(
		{
			finish: async (run, status, error, judgment) => {
				const summary = run.renderer?.summary();
				const ended = await client.finishRun(run.runId, {
					status,
					...(error ? { error } : {}),
					...judgment,
					usage: summary?.usage ?? { cost_source: 'none' },
					...(summary?.pricingEvidence
						? {
								pricing_evidence: {
									...summary.pricingEvidence,
									model: run.pricingModel ?? null,
									session_mode: run.pricingSessionMode ?? 'cold',
									daemon_version: DAEMON_VERSION
								}
							}
						: {}),
					...(summary?.providerSessionId ? { provider_session_id: summary.providerSessionId } : {}),
					...(summary?.numTurns !== undefined ? { turn_count: summary.numTurns } : {}),
					// The whole conversation's turns, which for a resumed run is
					// more than this run's own: the size guard reads this one.
					...(summary?.numTurns !== undefined
						? { conversation_turn_count: run.priorTurns + summary.numTurns }
						: {}),
					workspace_path: run.workspace
				});
				// The server decides retention: it alone knows whether the issue
				// landed in an awaiting state and whether this runner is opted
				// in. A `resume_expires_at` on the ended run means "hold this
				// workspace and its session", so the release below keeps it.
				if (ended?.resume_expires_at) run.keepForResume = true;
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
		},
		{
			// A workspace the server retained for a resume is kept whatever the
			// --keep-workspaces mode says; pruning still bounds it by age/count.
			keep: (outcome, run) => run.keepForResume || keepWorkspace(opts.keepWorkspaces, outcome)
		}
	);

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
				log(
					`killing orphaned harness from a previous life: run ${orphan.run_id} (pid ${orphan.pid})`
				);
				killTree(orphan.pid, 'SIGKILL');
			}
		}
		try {
			// The daemon's restart killed this run, not the agent: report it as
			// an interruption so the issue keeps its attempt budget.
			await client.finishRun(orphan.run_id, {
				status: 'failed',
				error: 'daemon restarted; orphaned harness killed',
				judgment: 'interrupted',
				usage: { cost_source: 'none' }
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
		// A resumed run reuses its predecessor's workspace — the repositories,
		// the edits and the harness's own session state are all still there —
		// unless the daemon can no longer find it, in which case this is a
		// fresh launch into a fresh directory and the reduced prompt is the
		// only thing that changes.
		const resume =
			assignment.resume && existsSync(assignment.resume.workspace_path) ? assignment.resume : null;
		if (assignment.resume && !resume) {
			log(
				`run ${runId}: resume workspace ${assignment.resume.workspace_path} is gone; launching fresh`
			);
		}
		const workspace = resume ? resume.workspace_path : join(workspacesDir(opts.configDir), runId);
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
			priorTurns: resume?.prior_turn_count ?? 0,
			keepForResume: false,
			batcher: new LogBatcher(
				(chunk, seq) => client.appendRunLog(runId, { chunk, seq }).then(() => {}),
				{ onError: (err) => log(`log append for run ${runId} failed: ${message(err)}`) }
			)
		};
		run.flush = () => run.batcher.flush();
		table.track(run);
		log(
			resume
				? `run ${runId} assigned (issue ${issueLabel ?? assignment.run.issue_id}); resuming run ${resume.previous_run_id} in ${workspace}`
				: `run ${runId} assigned (issue ${issueLabel ?? assignment.run.issue_id}); materializing workspace`
		);

		try {
			// The workspace: exactly the `issues context --out` layout. A resumed
			// run inherits its predecessor's, so only prompt.md is rewritten —
			// wiping and re-cloning is the cost this whole path exists to skip.
			if (!resume) {
				rmSync(workspace, { recursive: true, force: true });
				mkdirSync(workspace, { recursive: true });
			} else {
				rmSync(join(workspace, 'kept.json'), { force: true });
			}
			writeFileSync(join(workspace, 'prompt.md'), `${assignment.prompt}\n`);
			if (!resume)
				for (const skill of assignment.bundle.skills) {
					for (const file of skill.files) {
						const target = join(workspace, 'skills', skill.name, file.path);
						mkdirSync(dirname(target), { recursive: true });
						writeFileSync(target, file.content);
					}
				}
			if (!resume)
				writeFileSync(
					join(workspace, 'repos.json'),
					`${JSON.stringify(assignment.bundle.repos, null, 2)}\n`
				);

			// Clone the effective repos with the device's own git credentials.
			for (const repo of resume ? [] : assignment.bundle.repos) {
				if (run.settled) return table.cleanup(run);
				const args = [
					'clone',
					...(repo.branch ? ['--branch', repo.branch] : []),
					repo.url,
					repo.dir
				];
				run.batcher.append(`$ git ${args.join(' ')}\n`);
				const result = await runGit(args, workspace, run.batcher);
				if (result !== 0) {
					return table.finishAndCleanup(
						run,
						'failed',
						`git clone failed for ${repo.url} (exit ${result})`
					);
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
				model: assignment.run.model,
				...(resume ? { resumeSessionId: resume.provider_session_id } : {})
			};
			const invocation = buildHarnessInvocation(
				{ harness: opts.harness, command: opts.command },
				harnessInput
			);
			if (opts.harness === 'codex') {
				run.pricingModel = harnessInput.model;
				run.pricingSessionMode = resume ? 'resumed' : 'cold';
			}
			// What we are about to run, in the log itself: a failed run is read
			// long after the daemon's console scrolled away (or was swallowed by
			// launchd), and "which model / which timeout / which expanded
			// --command?" is otherwise unanswerable from the run.
			run.batcher.append(
				formatLaunchBanner(invocation, harnessInput, {
					harness: opts.harness,
					timeoutMinutes: assignment.timeout_minutes,
					cliVersion: DAEMON_VERSION,
					...(resume ? { resumedFromRunId: resume.previous_run_id } : {})
				})
			);
			const child = spawn(invocation.file, invocation.args, {
				cwd: workspace,
				env: buildSpawnEnv(process.env, {
					binDir: cli.binDir,
					apiKey: assignment.run_key,
					apiUrl: baseUrl
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
				// The detector reads the same parsed events the renderer does, so
				// the stream is parsed once — and every stderr chunk below.
				const limiter = new RateLimitDetector();
				run.limiter = limiter;
				const renderer = new ClaudeStreamRenderer(
					(line) => run.batcher.append(line),
					(event) => limiter.noteStreamEvent(event)
				);
				run.renderer = renderer;
				const spoolPath = join(opts.configDir, 'rawlogs', `${runId}.ndjson`);
				mkdirSync(dirname(spoolPath), { recursive: true });
				run.rawSpoolPath = spoolPath;
				run.rawSpool = createWriteStream(spoolPath);
				run.rawUpload = (body) => client.putRunLogRaw(runId, body);
				const decoder = new StringDecoder('utf8');
				run.drain = () => {
					const trailing = decoder.end();
					if (trailing) renderer.write(trailing);
					renderer.finish();
				};
				child.stdout?.on('data', (data: Buffer) => {
					run.rawSpool?.write(data);
					renderer.write(decoder.write(data));
				});
			} else if (opts.harness === 'codex') {
				const renderer = new CodexStreamRenderer((line) => run.batcher.append(line));
				const decoder = new StringDecoder('utf8');
				run.renderer = renderer;
				run.drain = () => {
					const trailing = decoder.end();
					if (trailing) renderer.write(trailing);
					renderer.finish();
				};
				child.stdout?.on('data', (data: Buffer) => renderer.write(decoder.write(data)));
			} else {
				child.stdout?.on('data', (data: Buffer) => run.batcher.append(data.toString('utf8')));
			}
			// stderr is never stream-json — it is the harness's own diagnostics,
			// and it goes to the log verbatim for every harness.
			child.stderr?.on('data', (data: Buffer) => {
				const text = data.toString('utf8');
				run.batcher.append(text);
				// Usage exhaustion at process start and some provider/transport
				// failures only appear here; stdout is empty in those cases.
				run.limiter?.noteStderr(text);
			});
			run.timeout = setTimeout(() => {
				if (run.settled) return;
				log(`run ${runId} hit its ${assignment.timeout_minutes}m timeout; killing`);
				run.timedOut = true;
				if (child.pid) killTree(child.pid, 'SIGTERM');
				if (child.pid) setTimeout(() => killTree(child.pid!, 'SIGKILL'), 5000).unref?.();
			}, assignment.timeout_minutes * 60_000);
			child.on('error', (err) => {
				void table.finishAndCleanup(run, 'failed', `failed to launch harness: ${message(err)}`);
			});
			child.on('close', (code, signal) => {
				// The harness's last words first — a stream renderer holding a
				// partial line emits it here (drain is idempotent, and
				// finishAndCleanup calls it too), so the closing line below is
				// really the log's last.
				run.drain?.();
				run.limiter?.finish();
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
					// A non-zero exit whose cause was the provider refusing on a
					// usage limit is the runner's condition, not the issue's
					// fault: report it without a strike and say when the window
					// reopens, so the supervisor can hold the runner until then.
					// A signal is our own kill, so it keeps its existing report.
					const limited = signal ? null : (run.limiter?.signal() ?? null);
					const providerError = signal ? null : (run.limiter?.providerError() ?? null);
					if (limited) {
						log(
							`run ${runId}: harness rate limited (${limited.detail}); reporting without a strike`
						);
						void table.finishAndCleanup(run, 'failed', `rate limited: ${limited.detail}`, {
							judgment: 'rate_limited',
							...(limited.resumeAt !== null ? { resume_at: limited.resumeAt } : {})
						});
					} else if (providerError) {
						log(
							`run ${runId}: transient provider error (${providerError.detail}); reporting without a strike`
						);
						void table.finishAndCleanup(run, 'failed', `provider error: ${providerError.detail}`, {
							judgment: 'interrupted'
						});
					} else {
						void table.finishAndCleanup(
							run,
							'failed',
							signal ? `harness killed by ${signal}` : `harness exited with code ${code}`
						);
					}
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
				await table.finishAndCleanup(run, 'failed', 'daemon shut down', {
					judgment: 'interrupted'
				});
			})
		);
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown());
	process.on('SIGTERM', () => void shutdown());

	// -- the poll loop ---------------------------------------------------------
	log(
		`polling ${baseUrl} every ${Math.round(opts.pollIntervalMs / 1000)}s (harness ${opts.harness}, max ${opts.maxConcurrent} concurrent) — Ctrl-C to stop`
	);
	let failures = 0;
	while (!shuttingDown) {
		try {
			// `max_concurrent` rides along so the server cap tracks the flag —
			// a restart with a new --max-concurrent takes effect without
			// re-registering.
			const res = await client.pollRunner(creds.runner_id, {
				instance_id: instanceId,
				owned_runs: table.ids(),
				max_concurrent: opts.maxConcurrent,
				// Stated on every poll while pending; absent otherwise, which
				// the server reads as "not draining" — so a daemon that died
				// mid-drain cannot pin its runner shut past its relaunch.
				...(pendingUpdate ? { draining: true } : {})
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
			// Launches are the only other refresh trigger, and an idle daemon
			// never launches — so it would never learn of a newer release.
			// TTL-gated (one npm run per 10 minutes at most), and pointless
			// once a restart is already pending.
			if (selfUpdate && !pendingUpdate) void ensureCli();
			// `launch` tracks its run before its first await, so an empty
			// table here means nothing is in flight and nothing was just
			// delivered. Exit for the service manager; the relaunched daemon
			// polls within seconds and any run assigned meanwhile is still
			// waiting for it.
			if (pendingUpdate && res.assignments.length === 0 && table.size === 0) {
				await refresher.settled();
				log(
					`exiting to restart as tines ${pendingUpdate} — the service manager relaunches this daemon (KeepAlive / Restart=always)`
				);
				process.exit(0);
			}
		} catch (err) {
			if (err instanceof ApiError && err.status === 409 && err.code === 'runner_conflict') {
				console.error(
					`runner ${opts.name} was superseded by another daemon instance; this daemon is exiting`
				);
				await shutdown();
				return;
			}
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
				clearRunnerCredentials(opts.configDir, baseUrl, opts.name);
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

/**
 * A path with its symlinks resolved, or null when it cannot be. For the
 * daemon's own entry script (`process.argv[1]`) this turns the npm
 * `.bin/tines` shim in the managed prefix into that prefix's
 * `node_modules/tines/dist/index.js`, which is what the prefix check needs.
 */
function realpathOrNull(path: string | undefined): string | null {
	if (!path) return null;
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
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
