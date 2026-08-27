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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, platform, arch } from 'node:os';
import { dirname, join } from 'node:path';
import { ApiError, createApiClient, type RunnerAssignment } from '@tines/shared';
import {
	clearRunnerCredentials,
	daemonStatePath,
	loadDaemonState,
	loadRunnerCredentials,
	processStartTimeMs,
	saveDaemonState,
	saveRunnerCredentials,
	type DaemonStateEntry,
	type RunnerCredentials
} from './store.js';
import {
	buildHarnessInvocation,
	LogBatcher,
	RunTable,
	type HarnessKind,
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
}

interface ActiveRun extends ManagedRun {
	child?: ChildProcess;
	batcher: LogBatcher;
	timeout?: ReturnType<typeof setTimeout>;
	keyFingerprint: string;
	spawnedAt?: number;
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

	const table: RunTable<ActiveRun> = new RunTable<ActiveRun>({
		finish: async (run, status, error) => {
			await client.finishRun(run.runId, { status, ...(error ? { error } : {}) });
		},
		release: (run) => {
			if (run.timeout) clearTimeout(run.timeout);
			rmSync(run.workspace, { recursive: true, force: true });
		},
		persist: () => {
			const entries: DaemonStateEntry[] = table
				.values()
				.filter((run) => run.child?.pid !== undefined)
				.map((run) => ({
					run_id: run.runId,
					pid: run.child!.pid!,
					workspace: run.workspace,
					key_fingerprint: run.keyFingerprint,
					started_at: run.spawnedAt
				}));
			saveDaemonState(statePath, entries);
		},
		log
	});

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
		rmSync(orphan.workspace, { recursive: true, force: true });
	}
	saveDaemonState(statePath, []);

	const killWithoutFinish = (runId: string) => {
		const run = table.markCanceled(runId);
		if (!run) return;
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
		const workspace = join(opts.configDir, 'workspaces', runId);
		const run: ActiveRun = {
			runId,
			workspace,
			canceled: false,
			timedOut: false,
			settled: false,
			keyFingerprint: assignment.run_key.slice(0, 14),
			batcher: new LogBatcher((chunk) => client.appendRunLog(runId, { chunk }).then(() => {}), {
				onError: (err) => log(`log append for run ${runId} failed: ${message(err)}`)
			})
		};
		run.flush = () => run.batcher.flush();
		table.track(run);
		log(`run ${runId} assigned (issue ${assignment.run.issue_ref ? `${assignment.run.issue_ref.project_name}/${assignment.run.issue_ref.number}` : assignment.run.issue_id}); materializing workspace`);

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

			const invocation = buildHarnessInvocation(
				{ harness: opts.harness, command: opts.command },
				{
					workspace,
					promptFile: join(workspace, 'prompt.md'),
					prompt: assignment.prompt,
					model: assignment.run.model
				}
			);
			const child = spawn(invocation.file, invocation.args, {
				cwd: workspace,
				env: { ...process.env, TINES_API_KEY: assignment.run_key, TINES_API_URL: opts.url },
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: true
			});
			run.child = child;
			run.spawnedAt = Date.now();
			table.persist();
			log(`run ${runId}: launched ${invocation.file} (pid ${child.pid})`);

			child.stdout?.on('data', (data: Buffer) => run.batcher.append(data.toString('utf8')));
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
			const res = await client.pollRunner(creds.runner_id, { owned_runs: table.ids() });
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
					rmSync(run.workspace, { recursive: true, force: true });
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
