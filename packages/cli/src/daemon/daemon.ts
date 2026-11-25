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
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApiError, createApiClient } from '@tines/shared';
import { cliVersion } from '../version.js';
import { EffortCapabilityRefresher } from './effort-capabilities.js';
import {
	killTree,
	uploadRawLog,
	launchAssignment,
	finishAssignment,
	type ExecutionOptions,
	type ActiveRun
} from './assignment.js';
import { agentCliPrefix, installAgentCli } from './cli-refresh.js';
import { ensureRunnerCredentials, nextStepsMessage } from './register.js';
import {
	clearRunnerCredentials,
	daemonDeclinesPath,
	daemonStatePath,
	loadDaemonDeclines,
	loadDaemonState,
	processStartTimeMs,
	pruneKeptWorkspaces,
	saveDaemonState,
	saveDaemonDeclines,
	workspacesDir,
	writeKeptMarker,
	type DaemonStateEntry,
	type KeptWorkspaceMarker,
	type RunnerCredentials
} from './store.js';
import {
	AMBIENT_CLI,
	CliRefresher,
	keepWorkspace,
	pathWithin,
	pendingSelfUpdate,
	RunTable,
	type AgentCli,
	type KeepWorkspacesMode
} from './support.js';

export interface DaemonOptions extends ExecutionOptions {
	/** User API key — only needed for first registration (or re-registration). */
	apiKey?: string;
	name: string;
	maxConcurrent: number;
	/** Machine-local consent for web requests; maxConcurrent remains the hard ceiling. */
	allowRemoteConcurrency: boolean;
	pollIntervalMs: number;
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

const log = (message: string) =>
	console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
		allowRemoteConcurrency: opts.allowRemoteConcurrency,
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
	const declinesPath = daemonDeclinesPath(opts.configDir, creds.runner_id);
	let shuttingDown = false;
	let effectiveConcurrency = opts.allowRemoteConcurrency ? 1 : opts.maxConcurrent;
	let appliedConcurrency: { revision: number; cap: number } | undefined;
	const declinedAssignments = new Set(loadDaemonDeclines(declinesPath));
	let warnedUnsupportedConcurrency = false;

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
	const pendingCancellationAcks = new Map<string, string>();

	const table: RunTable<ActiveRun> = new RunTable<ActiveRun>(
		{
			finish: finishAssignment(opts.harness, client),
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
			acknowledgeCancellation: async (run) => {
				if (run.cancellationToken) pendingCancellationAcks.set(run.runId, run.cancellationToken);
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
	const effortRefresher = new EffortCapabilityRefresher(opts.harness, DAEMON_VERSION);
	await effortRefresher.get();

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
		`polling ${baseUrl} every ${Math.round(opts.pollIntervalMs / 1000)}s (harness ${opts.harness}, ${opts.allowRemoteConcurrency ? `web-adjustable with local ceiling ${opts.maxConcurrent}` : `local cap ${opts.maxConcurrent}`}) — Ctrl-C to stop`
	);
	let failures = 0;
	while (!shuttingDown) {
		try {
			const effortCapabilities = await effortRefresher.get();
			const res = await client.pollRunner(creds.runner_id, {
				instance_id: instanceId,
				owned_runs: table.ids(),
				...(pendingCancellationAcks.size > 0
					? {
							cancellation_acks: [...pendingCancellationAcks]
								.slice(0, 100)
								.map(([run_id, token]) => ({
									run_id,
									token
								}))
						}
					: {}),
				// Kept for older servers. Opted-in daemons advertise only the last
				// accepted scheduling cap, never the higher machine ceiling.
				max_concurrent: effectiveConcurrency,
				concurrency_control: {
					version: 1,
					allow_remote: opts.allowRemoteConcurrency,
					ceiling: opts.maxConcurrent,
					...(appliedConcurrency ? { applied: appliedConcurrency } : {})
				},
				...(declinedAssignments.size > 0
					? { declined_assignments: [...declinedAssignments].slice(0, 100) }
					: {}),
				...(effortCapabilities ? { effort_capabilities: effortCapabilities } : {}),
				// Capability: this daemon merges assignment.env into the harness environment.
				env_delivery: 1,
				// Stated on every poll while pending; absent otherwise, which
				// the server reads as "not draining" — so a daemon that died
				// mid-drain cannot pin its runner shut past its relaunch.
				...(pendingUpdate ? { draining: true } : {})
			});
			failures = 0;
			for (const ack of res.cancellation_acks ?? []) {
				if (pendingCancellationAcks.get(ack.run_id) === ack.token) {
					pendingCancellationAcks.delete(ack.run_id);
				}
			}
			for (const request of res.cancel_requests ?? []) {
				table.noteCancellationRequest(request.run_id, request.token);
			}
			for (const runId of res.cancels) killWithoutFinish(runId);
			let declinesChanged = false;
			for (const runId of res.released_assignments ?? []) {
				if (declinedAssignments.delete(runId)) declinesChanged = true;
			}
			if (declinesChanged) saveDaemonDeclines(declinesPath, declinedAssignments);
			if (res.concurrency_control) {
				const control = res.concurrency_control;
				if (
					opts.allowRemoteConcurrency &&
					control.available &&
					Number.isSafeInteger(control.revision) &&
					Number.isInteger(control.cap) &&
					control.cap >= 1 &&
					control.cap <= opts.maxConcurrent
				) {
					effectiveConcurrency = control.cap;
					appliedConcurrency = { revision: control.revision, cap: control.cap };
				}
			} else if (opts.allowRemoteConcurrency && !warnedUnsupportedConcurrency) {
				warnedUnsupportedConcurrency = true;
				log(
					'web concurrency adjustment unavailable: upgrade the server; retaining conservative cap'
				);
			}
			for (const assignment of res.assignments) {
				if (declinedAssignments.size > 0 || table.size >= opts.maxConcurrent) {
					log(
						`run ${assignment.run.id}: refusing launch beyond local ceiling ${opts.maxConcurrent}; requesting safe release`
					);
					declinedAssignments.add(assignment.run.id);
					saveDaemonDeclines(declinesPath, declinedAssignments);
					continue;
				}
				void launchAssignment(
					assignment,
					{ ...opts, url: baseUrl },
					{ table, client, ensureCli, effortRefresher, log }
				);
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
