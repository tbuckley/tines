import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	type WriteStream
} from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
	RUN_LOG_RAW_MAX_BYTES,
	type AppendRunLogRequest,
	type FinishRunRequest,
	type RunnerAssignment
} from '@tines/shared';
import { cliVersion } from '../version.js';
import { ClaudeStreamRenderer } from './claude-stream';
import { CodexStreamRenderer } from './codex-stream.js';
import { PiRawSpoolFilter, PiStreamRenderer } from './pi-stream.js';
import { collectCodexRequestContext, resolveCodexHome } from './codex-rollout.js';
import type { RunStreamRenderer } from './stream-summary.js';
import { RateLimitDetector } from './rate-limit';
import { assignmentEffortRejection, EffortCapabilityRefresher } from './effort-capabilities.js';
import { assertNoSkillRepoOverlap, materializeSkills } from '../skills.js';
import { workspacesDir } from './store.js';
import {
	buildHarnessInvocation,
	buildSpawnEnv,
	classifyExit,
	SecretRedactor,
	redactSecrets,
	exitLineForRun,
	formatLaunchBanner,
	LogBatcher,
	PI_SESSION_DIR,
	RunTable,
	type AgentCli,
	type HarnessKind,
	type ManagedRun,
	type RunTableEffects
} from './support.js';

const DAEMON_VERSION = cliVersion();

export interface ExecutionOptions {
	url: string;
	configDir: string;
	harness: HarnessKind;
	command?: string;
	cliRefresh: boolean;
}

export interface RunReporter {
	appendRunLog(runId: string, body: AppendRunLogRequest): Promise<unknown>;
	putRunLogRaw(runId: string, body: Uint8Array): Promise<unknown>;
	finishRun(
		runId: string,
		body: FinishRunRequest
	): Promise<{ resume_expires_at?: number | null } | void>;
}

export interface ActiveRun extends ManagedRun {
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
	/** claude_code, pi: the unrendered stream, spooled for the raw-log upload. */
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
	effortEvidence?: NonNullable<FinishRunRequest['effort_application']>;
	/** pi: why the daemon killed the run — it applied another effort than assigned. */
	effortMismatch?: string;
	pricingSessionMode?: 'cold' | 'resumed';
	codexHome?: string;
}

/**
 * Uploads a claude_code run's unrendered NDJSON stream, then deletes the
 * spool. Best-effort throughout: the rendered log is already durable, and a
 * failure here costs the raw copy, not the run.
 */
export async function uploadRawLog(run: {
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

/**
 * Whether `pi --session <id>` has a session to reopen in this workspace. Pi
 * names each session file `<timestamp>_<id>.jsonl` under its session dir.
 */
function piSessionExists(workspace: string, sessionId: string): boolean {
	try {
		return readdirSync(join(workspace, PI_SESSION_DIR)).some((name) =>
			name.endsWith(`_${sessionId}.jsonl`)
		);
	} catch {
		return false;
	}
}

export function killTree(pid: number, signal: NodeJS.Signals): void {
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

export function finishAssignment(
	harness: HarnessKind,
	client: RunReporter
): RunTableEffects<ActiveRun>['finish'] {
	return async (run, status, error, judgment) => {
		const summary = run.renderer?.summary();
		if (summary?.pricingEvidence && harness === 'codex') {
			const raw = summary.pricingEvidence.raw_usage;
			const completeRaw =
				raw &&
				['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'].every(
					(field) => raw[field as keyof typeof raw] !== undefined
				);
			if (
				status === 'completed' &&
				run.pricingSessionMode === 'cold' &&
				summary.pricingEvidence.measurement_status === 'complete' &&
				completeRaw &&
				summary.providerSessionId &&
				run.codexHome &&
				run.spawnedAt
			) {
				summary.pricingEvidence.request_context = await collectCodexRequestContext({
					codexHome: run.codexHome,
					threadId: summary.providerSessionId,
					model: run.pricingModel ?? null,
					startedAt: run.spawnedAt,
					endedAt: Date.now(),
					terminalUsage: raw as Required<typeof raw>
				});
				if (
					'reason' in summary.pricingEvidence.request_context &&
					summary.pricingEvidence.request_context.reason === 'model_mismatch'
				)
					summary.pricingEvidence.model_rerouted = true;
			} else {
				summary.pricingEvidence.request_context = {
					version: 1,
					normalization: 'codex-rollout-delta-v1',
					status: 'unavailable',
					reason: 'not_applicable'
				};
			}
		}
		const accounting = {
			usage: summary?.usage ?? { cost_source: 'none' as const },
			...(summary?.pricingEvidence ? { pricing_evidence: summary.pricingEvidence } : {}),
			...(summary?.providerSessionId ? { provider_session_id: summary.providerSessionId } : {}),
			daemon_version: DAEMON_VERSION,
			status
		};
		run.batcher.append(`[usage] ${JSON.stringify(accounting)}\n`);
		await run.batcher.finish();
		const ended = await client.finishRun(run.runId, {
			status,
			...(run.effortEvidence ? { effort_application: run.effortEvidence } : {}),
			...(error ? { error } : {}),
			...judgment,
			usage: accounting.usage,
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
	};
}
export async function launchAssignment(
	assignment: RunnerAssignment,
	opts: ExecutionOptions,
	{
		table,
		client,
		ensureCli,
		effortRefresher,
		log,
		freshWorkspace
	}: {
		freshWorkspace?: (runId: string) => string;
		table: RunTable<ActiveRun>;
		client: RunReporter;
		ensureCli: () => Promise<AgentCli>;
		effortRefresher: EffortCapabilityRefresher;
		log: (message: string) => void;
	}
) {
	// Env items live in this closure only: never the workspace files, the
	// banner, or daemon-state.json. Secret values also drive log masking.
	const secretEnvValues = [
		assignment.run_key,
		...(assignment.env ?? []).filter((e) => e.secret).map((e) => e.value)
	].filter(Boolean);
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
	const workspace = resume
		? resume.workspace_path
		: (freshWorkspace?.(runId) ?? join(workspacesDir(opts.configDir), runId));
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
			{
				onError: (err) => log(`log append for run ${runId} failed: ${message(err)}`),
				...(secretEnvValues.length > 0 ? { redact: secretEnvValues } : {})
			}
		)
	};
	run.flush = () => run.batcher.finish();
	table.track(run);
	// Enforced effort never trusts the catalog advertised by an earlier probe.
	// Reprobe the same PATH/environment used below and require the assignment's
	// digest to still match before any workspace or child process is started.
	const effortCapabilities = assignment.effort ? await effortRefresher.get(true) : undefined;
	if (run.settled) return table.cleanup(run);
	const effortRejection = assignmentEffortRejection(assignment, effortCapabilities, opts.harness);
	if (effortRejection && assignment.effort) {
		run.effortEvidence = {
			status: 'rejected',
			attempted_effort: assignment.effort.value,
			transport: 'argv',
			reason: effortRejection
		};
		await client
			.appendRunLog(runId, {
				chunk: '',
				effort_application: run.effortEvidence
			})
			.catch(() => undefined);
		return table.finishAndCleanup(run, 'failed', effortRejection);
	}
	log(
		resume
			? `run ${runId} assigned (issue ${issueLabel ?? assignment.run.issue_id}); resuming run ${resume.previous_run_id} in ${workspace}`
			: `run ${runId} assigned (issue ${issueLabel ?? assignment.run.issue_id}); materializing workspace`
	);

	try {
		const currentRepoDirs = assignment.bundle.repos.map((repo) => repo.dir);
		let retainedRepoDirs: string[] = [];
		if (resume) {
			const retainedPath = join(workspace, 'repos.json');
			let retained: unknown;
			try {
				retained = JSON.parse(readFileSync(retainedPath, 'utf8'));
			} catch (error) {
				throw new Error(
					`cannot safely refresh skills: retained ${retainedPath} is unreadable or invalid JSON (${message(error)})`
				);
			}
			if (
				!Array.isArray(retained) ||
				retained.some(
					(repo) =>
						!repo || typeof repo !== 'object' || typeof (repo as { dir?: unknown }).dir !== 'string'
				)
			) {
				throw new Error(
					`cannot safely refresh skills: retained ${retainedPath} must be an array of repositories with string dir fields`
				);
			}
			retainedRepoDirs = retained.map((repo) => (repo as { dir: string }).dir);
		}
		assertNoSkillRepoOverlap([...currentRepoDirs, ...retainedRepoDirs]);
		// The workspace: exactly the `issues context --out` layout. A resumed
		// run inherits its predecessor's repositories and edits, while the
		// generated skill subtree is replaced with the current effective set.
		if (!resume && !freshWorkspace) {
			rmSync(workspace, { recursive: true, force: true });
			mkdirSync(workspace, { recursive: true });
		} else if (resume) {
			rmSync(join(workspace, 'kept.json'), { force: true });
		}
		materializeSkills(workspace, assignment.bundle.skills);
		writeFileSync(join(workspace, 'prompt.md'), `${assignment.prompt}\n`);
		if (!resume)
			writeFileSync(
				join(workspace, 'repos.json'),
				`${JSON.stringify(assignment.bundle.repos, null, 2)}\n`
			);

		// Clone the effective repos with the device's own git credentials.
		for (const repo of resume ? [] : assignment.bundle.repos) {
			if (run.settled) return table.cleanup(run);
			const args = ['clone', ...(repo.branch ? ['--branch', repo.branch] : []), repo.url, repo.dir];
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

		// Pi's session lives in the kept workspace itself. If its file is gone
		// the workspace is still worth reusing, but there is no conversation
		// to reopen: say so and start one, rather than hand Pi a dead id.
		let resumeSessionId = resume?.provider_session_id;
		if (opts.harness === 'pi' && resumeSessionId && !piSessionExists(workspace, resumeSessionId)) {
			log(`run ${runId}: pi session ${resumeSessionId} is gone; launching fresh`);
			run.batcher.append(`pi session ${resumeSessionId} is gone; launching fresh\n`);
			resumeSessionId = undefined;
			run.priorTurns = 0;
		}
		const harnessInput = {
			workspace,
			promptFile: join(workspace, 'prompt.md'),
			prompt: assignment.prompt,
			model: assignment.run.model,
			effort: assignment.effort?.value ?? null,
			...(resumeSessionId ? { resumeSessionId } : {}),
			// Pi does not load `.agents/skills` in a folder it has not been told
			// to trust, so each materialized skill is named on the command line.
			...(opts.harness === 'pi'
				? { skillDirs: assignment.bundle.skills.map((skill) => `.agents/skills/${skill.name}`) }
				: {})
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
		const spawnEnv = buildSpawnEnv(process.env, {
			binDir: cli.binDir,
			apiKey: assignment.run_key,
			apiUrl: opts.url,
			...(assignment.env ? { extra: assignment.env } : {})
		});
		if (assignment.env?.length) {
			run.batcher.append(
				`[env] ${assignment.env.length} environment variable(s) set: ${assignment.env
					.map((e) => `${e.name}${e.secret ? ' (secret)' : ''}`)
					.join(', ')}\n`
			);
		}
		if (opts.harness === 'codex') run.codexHome = resolveCodexHome(spawnEnv, workspace);
		const child = spawn(invocation.file, invocation.args, {
			cwd: workspace,
			env: spawnEnv,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true
		});
		if (assignment.effort) {
			child.once('spawn', () => {
				run.effortEvidence = {
					status: 'accepted_unconfirmed',
					attempted_effort: assignment.effort!.value,
					transport: 'argv'
				};
				void client
					.appendRunLog(runId, {
						chunk: '',
						effort_application: run.effortEvidence
					})
					.catch((err) => log(`run ${runId}: effort evidence rejected: ${message(err)}`));
			});
		}
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
			const spoolPath = join(opts.configDir, 'rawlogs', `${runId}-${randomUUID()}.ndjson`);
			mkdirSync(dirname(spoolPath), { recursive: true });
			run.rawSpoolPath = spoolPath;
			run.rawSpool = createWriteStream(spoolPath);
			run.rawUpload = (body) => client.putRunLogRaw(runId, body);
			const decoder = new StringDecoder('utf8');
			const rawRedactor = new SecretRedactor(secretEnvValues);
			run.drain = () => {
				const trailing = decoder.end();
				if (trailing) {
					run.rawSpool?.write(rawRedactor.write(trailing));
					renderer.write(trailing);
				}
				run.rawSpool?.write(rawRedactor.end());
				renderer.finish();
			};
			child.stdout?.on('data', (data: Buffer) => {
				// The raw spool is uploaded verbatim, so it is masked too
				// (text, not the Buffer — the decoder owns partial code points).
				const text = decoder.write(data);
				run.rawSpool?.write(rawRedactor.write(text));
				renderer.write(text);
			});
		} else if (opts.harness === 'pi') {
			// Pi's JSONL is rendered for the log and spooled for the raw upload
			// as Claude's is, except that the spool drops the per-token lines
			// (PiRawSpoolFilter) so the upload's size cap keeps the whole run.
			const renderer = new PiStreamRenderer((line) => run.batcher.append(line), {
				resumed: Boolean(resumeSessionId),
				// Pi clamps `--thinking` to what the model supports without
				// saying so; the level its first answer records is the proof.
				// A match confirms an enforced effort. Anything else is a run
				// at an effort nobody assigned, so it stops here.
				onAppliedEffort: (level) => {
					const assigned = assignment.effort?.value;
					if (!assigned || run.settled) return;
					if (level === assigned) {
						run.effortEvidence = {
							status: 'confirmed',
							attempted_effort: assigned,
							transport: 'argv'
						};
					} else {
						const reason = `pi applied thinking level ${level.slice(0, 100)}, not the assigned ${assigned}`;
						// `observed_effort` is what makes the rejection outrank the
						// `accepted_unconfirmed` sent at spawn in the server's merge.
						run.effortEvidence = {
							status: 'rejected',
							attempted_effort: assigned,
							transport: 'argv',
							reason,
							observed_effort: level.slice(0, 100)
						};
						run.effortMismatch = reason;
						log(`run ${runId}: ${reason}; killing`);
						run.batcher.append(`[effort] ${reason}; stopping the run\n`);
						if (child.pid) killTree(child.pid, 'SIGTERM');
						if (child.pid) setTimeout(() => killTree(child.pid!, 'SIGKILL'), 5000).unref?.();
					}
					void client
						.appendRunLog(runId, { chunk: '', effort_application: run.effortEvidence })
						.catch((err) => log(`run ${runId}: effort evidence rejected: ${message(err)}`));
				}
			});
			run.renderer = renderer;
			const spoolPath = join(opts.configDir, 'rawlogs', `${runId}-${randomUUID()}.ndjson`);
			mkdirSync(dirname(spoolPath), { recursive: true });
			run.rawSpoolPath = spoolPath;
			run.rawSpool = createWriteStream(spoolPath);
			run.rawUpload = (body) => client.putRunLogRaw(runId, body);
			const decoder = new StringDecoder('utf8');
			const spoolFilter = new PiRawSpoolFilter();
			const rawRedactor = new SecretRedactor(secretEnvValues);
			run.drain = () => {
				const trailing = decoder.end();
				run.rawSpool?.write(
					rawRedactor.write(spoolFilter.write(trailing) + spoolFilter.end()) + rawRedactor.end()
				);
				if (trailing) renderer.write(trailing);
				renderer.finish();
			};
			child.stdout?.on('data', (data: Buffer) => {
				const text = decoder.write(data);
				run.rawSpool?.write(rawRedactor.write(spoolFilter.write(text)));
				renderer.write(text);
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
			const decoder = new StringDecoder('utf8');
			const redactor = new SecretRedactor(secretEnvValues);
			child.stdout?.on('data', (data: Buffer) =>
				run.batcher.append(redactor.write(decoder.write(data)))
			);
			run.drain = () => {
				run.batcher.append(redactor.write(decoder.end()) + redactor.end());
			};
		}
		// Each pipe owns its decoder/redactor: stderr may interrupt stdout in
		// the middle of a secret, so their pending prefixes cannot be shared.
		const stderrDecoder = new StringDecoder('utf8');
		const stderrRedactor = new SecretRedactor(secretEnvValues);
		const drainStdout = run.drain;
		run.drain = () => {
			drainStdout?.();
			run.batcher.append(stderrRedactor.write(stderrDecoder.end()) + stderrRedactor.end());
		};
		// stderr is never stream-json — it is the harness's own diagnostics,
		// and it goes to the log verbatim for every harness.
		child.stderr?.on('data', (data: Buffer) => {
			const text = stderrDecoder.write(data);
			run.batcher.append(stderrRedactor.write(text));
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
			const reason = redactSecrets(`failed to launch harness: ${message(err)}`, secretEnvValues);
			if (assignment.effort)
				run.effortEvidence = {
					status: 'rejected',
					attempted_effort: assignment.effort.value,
					transport: 'argv',
					reason
				};
			const evidence = assignment.effort
				? client
						.appendRunLog(runId, {
							chunk: '',
							effort_application: run.effortEvidence
						})
						.catch(() => undefined)
				: Promise.resolve();
			void evidence.then(() => table.finishAndCleanup(run, 'failed', reason));
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
			const { status, error, note, ...judgment } = classifyExit({
				harness: opts.harness,
				code,
				signal,
				timedOut: run.timedOut,
				timeoutMinutes: assignment.timeout_minutes,
				limited: run.limiter?.signal() ?? null,
				providerError: run.limiter?.providerError() ?? null,
				// The stream's own account of a provider refusal or failure.
				...(run.renderer ? { harnessOutcome: run.renderer.summary().harnessOutcome } : {}),
				effortMismatch: run.effortMismatch ?? null,
				secrets: secretEnvValues
			});
			if (note) log(`run ${runId}: ${note}; reporting without a strike`);
			void table.finishAndCleanup(run, status, error, judgment.judgment ? judgment : undefined);
		});
	} catch (err) {
		void table.finishAndCleanup(
			run,
			'failed',
			redactSecrets(`workspace setup failed: ${message(err)}`, secretEnvValues)
		);
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
