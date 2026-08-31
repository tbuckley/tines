/**
 * The local runner protocol: poll (heartbeat + one-shot assignment delivery
 * + `owned_runs` reconciliation + `cancels`), log append, and finish
 * (SPEC.md "Local runner protocol"). These endpoints authenticate with the
 * runner token — a credential kind of its own, valid nowhere else: API keys
 * (run keys included) fail here because their hash matches no
 * `runner_token_hash`, and runner tokens fail everywhere else because they
 * match no `api_key` row. Register and rotate-token are user-auth runner
 * management and live in runners.ts.
 */
import {
	ACTIVE_RUN_STATUSES,
	RUNNER_ONLINE_WINDOW_MS,
	type AgentRun,
	type AgentRunUsage,
	type AppendRunLogResponse,
	type FinishRunRequest,
	type RunnerAssignment,
	type RunnerPollRequest,
	type RunnerPollResponse
} from '@tines/shared';
import type { RequestEvent } from '@sveltejs/kit';
import type { Kysely } from 'kysely';
import { sha256Hex } from '$lib/server/crypto';
import { getDb, type Database } from '$lib/server/db';
import {
	endRun,
	loadEndableRun,
	markRunRunning,
	mintRunKeyAndFlip,
	supervisorEvent
} from '$lib/server/supervisor/engine';
import { spillEvicted } from '$lib/server/supervisor/run-log';
import { appendLogTail } from '$lib/server/supervisor/logic';
import { buildSupervisorPreamble } from '$lib/server/supervisor/preamble';
import { listArtifacts } from './artifacts';
import { buildLaunchPrompt, effectiveContextForIssue } from './context';
import { ApiFail, notFound, optionalString, runAtomic } from './core';
import { getIssueDetail } from './issues';
import { validateBoundedInt } from './runners';
import { runQuery, serializeRun } from './runs';

const ACTIVE = [...ACTIVE_RUN_STATUSES];

export type RunnerRow = Database['runner'];

/**
 * Resolves a bearer runner token to its runner row. Undefined = unknown (or
 * rotated) token; the caller 401s with the re-register/update guidance.
 */
export async function authenticateRunnerToken(
	db: Kysely<Database>,
	token: string
): Promise<RunnerRow | undefined> {
	const hash = await sha256Hex(token);
	return db
		.selectFrom('runner')
		.selectAll()
		.where('runner_token_hash', '=', hash)
		.executeTakeFirst();
}

/** The protocol's 401: covers missing, invalid, and rotated tokens alike. */
export function runnerTokenUnauthorized(): ApiFail {
	return new ApiFail(
		401,
		'runner_token_invalid',
		'Invalid or rotated runner token. Update the daemon with the token from ' +
			'`tines runners rotate-token`, or re-register by starting the daemon with a user TINES_API_KEY.'
	);
}

/**
 * Route context for the protocol endpoints: resolves the bearer runner
 * token, never a session or API key — run keys cannot call the protocol,
 * and 401 here covers them (their hash matches no runner).
 */
export async function runnerProtocolContext(
	event: RequestEvent
): Promise<{ db: Kysely<Database>; env: Env; runner: RunnerRow }> {
	if (!event.platform) throw new ApiFail(500, 'no_platform', 'Platform bindings unavailable');
	const header = event.request.headers.get('authorization');
	const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
	if (!token) {
		throw new ApiFail(
			401,
			'unauthorized',
			'Pass the runner token as "Authorization: Bearer <token>" (this endpoint accepts runner tokens only)'
		);
	}
	const db = getDb(event.platform.env);
	const runner = await authenticateRunnerToken(db, token);
	if (!runner) throw runnerTokenUnauthorized();
	return { db, env: event.platform.env, runner };
}

async function serializedRun(db: Kysely<Database>, userId: string, runId: string): Promise<AgentRun> {
	const row = await runQuery(db, userId).where('agent_run.id', '=', runId).executeTakeFirst();
	if (!row) throw notFound();
	return serializeRun(row);
}

// ---------------------------------------------------------------------------
// Poll

export interface PollOutcome {
	response: RunnerPollResponse;
	/** True when this poll brought an offline runner back — queue a dispatch pass. */
	cameOnline: boolean;
	/** True when this poll raised the runner's cap — new capacity, same dispatch pass. */
	capRaised: boolean;
}

function validateOwnedRuns(body: RunnerPollRequest): string[] {
	const owned = body.owned_runs;
	if (owned === undefined) return [];
	if (!Array.isArray(owned) || owned.length > 1000 || owned.some((id) => typeof id !== 'string')) {
		throw new ApiFail(422, 'invalid_field', '"owned_runs" must be an array of run ids', {
			field: 'owned_runs'
		});
	}
	return owned;
}

/**
 * One poll: bump `last_seen_at`, adopt the daemon's `max_concurrent` (the
 * flag is authoritative for the daemon's own cap, so a restart with a new
 * value takes effect without re-registering), fail this runner's `running`
 * runs the daemon no longer owns, compute the `cancels` list (owned runs the
 * supervisor already settled — kill, don't finish-report), and deliver
 * `assigned` runs one-shot via the guarded `assigned → launching` flip, with
 * launch materials (preamble + prompt + bundle) and the run key minted at
 * this moment (SPEC.md "Workspace setup and launch").
 */
export async function pollRunner(
	db: Kysely<Database>,
	env: Env,
	runner: RunnerRow,
	body: RunnerPollRequest,
	now: number = Date.now()
): Promise<PollOutcome> {
	const owned = new Set(validateOwnedRuns(body));
	const cap =
		body.max_concurrent === undefined
			? runner.max_concurrent
			: validateBoundedInt(body.max_concurrent, 'max_concurrent', 1, 100);
	const capChanged = cap !== runner.max_concurrent;
	const capRaised = cap > runner.max_concurrent;
	const cameOnline =
		runner.last_seen_at === null || now - runner.last_seen_at > RUNNER_ONLINE_WINDOW_MS;
	await runAtomic(env, [
		db
			.updateTable('runner')
			.set({ last_seen_at: now, ...(capChanged ? { max_concurrent: cap, updated_at: now } : {}) })
			.where('id', '=', runner.id)
			.compile(),
		// The same runner.updated event a UI edit records, so the change shows
		// up in history (attributed to the owning user; polls carry no actor).
		...(capChanged
			? [
					supervisorEvent(
						db,
						runner.user_id,
						{
							type: 'runner.updated',
							payload: { runner_id: runner.id, name: runner.name, changed: ['max_concurrent'] }
						},
						now
					)
				]
			: [])
	]);
	runner.max_concurrent = cap;

	const active = await db
		.selectFrom('agent_run')
		.selectAll()
		.where('runner_id', '=', runner.id)
		.where('status', 'in', ACTIVE)
		.orderBy('created_at asc')
		.orderBy('id asc')
		.execute();

	// `owned_runs` reconciles reality: a `running` run the daemon does not
	// report was lost to a daemon restart — fail it now rather than waiting
	// out the timeout. (`launching` runs stay for the launch-stall sweep: the
	// daemon may simply not have received them yet.)
	for (const run of active) {
		if (run.status !== 'running' || owned.has(run.id)) continue;
		const endable = await loadEndableRun(db, run.user_id, run.id);
		if (!endable || endable.status !== 'running') continue;
		await endRun(db, env, endable, {
			status: 'failed',
			error: 'lost by daemon (missing from owned_runs)',
			now
		});
	}

	// `cancels` means kill, not finish: every owned run that is no longer one
	// of this runner's live claims has been settled by the supervisor
	// (cancel, timeout, the offline sweep) — including ids we cannot even
	// resolve. The daemon kills the process and reports nothing.
	const live = new Set(
		active.filter((r) => r.status === 'launching' || r.status === 'running').map((r) => r.id)
	);
	const cancels = [...owned].filter((id) => !live.has(id));

	const assignments: RunnerAssignment[] = [];
	if (runner.status === 'active') {
		for (const run of active) {
			if (run.status !== 'assigned') continue;
			const assignment = await deliverAssignedRun(db, env, runner, run, now);
			if (assignment) assignments.push(assignment);
		}
	}

	return { response: { assignments, cancels }, cameOnline, capRaised };
}

/**
 * One-shot delivery of one `assigned` run. Launch materials are assembled
 * here — at poll-delivery, never claim time — and if the issue is no longer
 * eligible (transitioned away from the state the claim routed for, parked,
 * or automation disarmed) the assignment is canceled instead of delivered:
 * the issue re-enters the pool and routing re-evaluates. Null = nothing to
 * deliver (canceled here, or another poll won the flip).
 */
async function deliverAssignedRun(
	db: Kysely<Database>,
	env: Env,
	runner: RunnerRow,
	run: Database['agent_run'],
	now: number
): Promise<RunnerAssignment | null> {
	const [eligibility, settings] = await Promise.all([
		db
			.selectFrom('issue')
			.innerJoin('workflow_state as st', 'st.id', 'issue.state_id')
			.select(['issue.state_id', 'st.category', 'issue.needs_attention'])
			.where('issue.id', '=', run.issue_id)
			.executeTakeFirst(),
		db
			.selectFrom('supervisor_settings')
			.select('enabled')
			.where('user_id', '=', run.user_id)
			.executeTakeFirst()
	]);
	const eligible =
		eligibility !== undefined &&
		eligibility.state_id === run.state_id_at_start &&
		eligibility.category === 'active' &&
		eligibility.needs_attention === 0 &&
		settings?.enabled === 1;
	if (!eligible) {
		const endable = await loadEndableRun(db, run.user_id, run.id);
		if (endable && endable.status === 'assigned') {
			await endRun(db, env, endable, {
				status: 'canceled',
				error: 'assignment canceled: issue no longer eligible at delivery',
				now
			});
		}
		return null;
	}

	// The guarded one-shot flip; a lost race means another poll (a second
	// daemon sharing this token) already took it — degrade to skipping.
	const minted = await mintRunKeyAndFlip(db, env, {
		runId: run.id,
		userId: run.user_id,
		maxRunMinutes: runner.max_run_minutes,
		now
	});
	if (!minted) return null;

	const [issue, bundle, artifacts] = await Promise.all([
		getIssueDetail(db, run.user_id, { id: run.issue_id }),
		effectiveContextForIssue(db, run.user_id, run.issue_id),
		listArtifacts(db, run.user_id, run.issue_id)
	]);
	const preamble = buildSupervisorPreamble({
		variant: 'local',
		runId: run.id,
		runnerName: runner.name,
		issueRef: `${issue.project_name}/${issue.number}`,
		timeoutMinutes: runner.max_run_minutes
	});
	return {
		run: await serializedRun(db, run.user_id, run.id),
		prompt: `${preamble}\n\n${buildLaunchPrompt(bundle, issue, artifacts)}`,
		bundle,
		run_key: minted.secret,
		timeout_minutes: runner.max_run_minutes
	};
}

// ---------------------------------------------------------------------------
// Log append: 256 KB tail, truncated from the head (appendLogTail lives in
// supervisor/logic.ts so the sweep's managed-run polling shares it)

export { appendLogTail };

/** Loads a run for the protocol, scoped to the authenticated runner (404 across runners). */
async function loadRunnerRun(
	db: Kysely<Database>,
	runner: RunnerRow,
	runId: string
): Promise<Database['agent_run']> {
	const run = await db
		.selectFrom('agent_run')
		.selectAll()
		.where('id', '=', runId)
		.where('runner_id', '=', runner.id)
		.executeTakeFirst();
	if (!run) throw notFound();
	return run;
}

/**
 * `POST /api/v1/runs/:id/logs`: appends a chunk to the head-truncated tail.
 * The first append is the daemon's "the harness is up" signal, flipping the
 * run `launching → running` (SPEC.md: `launching` covers workspace
 * materialization; output means the agent is working).
 */
export async function appendRunLog(
	db: Kysely<Database>,
	env: Env,
	runner: RunnerRow,
	runId: string,
	chunk: unknown,
	now: number = Date.now(),
	seq?: unknown
): Promise<AppendRunLogResponse> {
	if (typeof chunk !== 'string' || chunk.length > 1_000_000) {
		throw new ApiFail(422, 'invalid_field', '"chunk" must be a string of at most 1,000,000 characters', {
			field: 'chunk'
		});
	}
	if (seq !== undefined && (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1)) {
		throw new ApiFail(422, 'invalid_field', '"seq" must be a positive integer', { field: 'seq' });
	}
	const run = await loadRunnerRun(db, runner, runId);
	if (run.status === 'assigned') {
		throw new ApiFail(422, 'run_not_delivered', 'This run has not been delivered to the daemon yet');
	}
	if (!(ACTIVE as string[]).includes(run.status)) {
		throw new ApiFail(422, 'run_already_ended', 'This run has already ended; the log is closed');
	}
	// Exactly-once: a daemon that retries a chunk whose response it never saw
	// resends the same seq, and the append is already applied. Ack it as-is
	// rather than duplicating the bytes into the tail and into R2.
	if (seq !== undefined && seq <= run.log_seq) {
		return {
			status: run.status as AppendRunLogResponse['status'],
			log_bytes_dropped: run.log_bytes_dropped,
			log_seq: run.log_seq
		};
	}
	if (run.status === 'launching') {
		await markRunRunning(db, env, run, now);
	}
	const appended = appendLogTail(run.log, run.log_bytes_dropped, chunk);
	// Bytes the tail evicts go to R2 *before* the D1 update, so D1 never
	// records dropped bytes that no object holds. The reverse — an object
	// whose update then loses the status guard — is an orphan the sweep GCs.
	const spill = appended.evicted ? await spillEvicted(env, run, appended.evicted) : null;
	await runAtomic(env, [
		db
			.updateTable('agent_run')
			.set({
				log: appended.log,
				log_bytes_dropped: appended.dropped,
				...(spill ?? {}),
				...(seq === undefined ? {} : { log_seq: seq })
			})
			.where('id', '=', runId)
			// A chunk racing a cancel/sweep must not extend a settled run's
			// tail: the active check above was a read, this is the guard.
			.where('status', 'in', ACTIVE)
			// …and a concurrent append must not clobber this one's part
			// bookkeeping: both would claim the same part index.
			.where('log_part_count', '=', run.log_part_count)
			.compile()
	]);
	return {
		status: run.status === 'launching' ? 'running' : (run.status as AppendRunLogResponse['status']),
		log_bytes_dropped: appended.dropped,
		log_seq: seq ?? run.log_seq
	};
}

// ---------------------------------------------------------------------------
// Finish

const REPORTABLE = ['completed', 'failed'] as const;

function validateUsage(value: unknown): AgentRunUsage | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new ApiFail(422, 'invalid_field', '"usage" must be an object', { field: 'usage' });
	}
	const raw = value as Record<string, unknown>;
	const usage: AgentRunUsage = {};
	for (const field of [
		'input_tokens',
		'output_tokens',
		'cache_read_tokens',
		'cache_write_tokens',
		'cost_usd'
	] as const) {
		if (raw[field] === undefined) continue;
		if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field]) || (raw[field] as number) < 0) {
			throw new ApiFail(422, 'invalid_field', `"usage.${field}" must be a non-negative number`, {
				field: `usage.${field}`
			});
		}
		usage[field] = raw[field] as number;
	}
	if (raw.cost_source !== undefined) {
		if (!['provider', 'priced', 'none'].includes(raw.cost_source as string)) {
			throw new ApiFail(422, 'invalid_field', '"usage.cost_source" must be provider, priced, or none', {
				field: 'usage.cost_source'
			});
		}
		usage.cost_source = raw.cost_source as AgentRunUsage['cost_source'];
	}
	return usage;
}

/**
 * `POST /api/v1/runs/:id/finish`: the daemon's end report → endRun with
 * immediate key revocation and the usual judgment. A finish arriving while
 * the run is still `launching` (a harness that never emitted output) flips
 * it to `running` first, so a do-nothing run is judged — and struck — like
 * any other.
 */
export async function finishRun(
	db: Kysely<Database>,
	env: Env,
	runner: RunnerRow,
	runId: string,
	body: FinishRunRequest,
	now: number = Date.now()
): Promise<AgentRun> {
	if (!REPORTABLE.includes(body.status)) {
		throw new ApiFail(422, 'invalid_field', '"status" must be "completed" or "failed"', {
			field: 'status'
		});
	}
	const error = optionalString(body.error, 'error', { max: 10_000 });
	const usage = validateUsage(body.usage);

	const run = await loadRunnerRun(db, runner, runId);
	if (run.status === 'assigned') {
		throw new ApiFail(422, 'run_not_delivered', 'This run has not been delivered to the daemon yet');
	}
	if (!(ACTIVE as string[]).includes(run.status)) {
		throw new ApiFail(
			422,
			'run_already_ended',
			'This run has already ended (canceled, timed out, or swept); nothing to report'
		);
	}
	if (run.status === 'launching') {
		await markRunRunning(db, env, run, now);
	}
	if (usage) {
		await runAtomic(env, [
			db.updateTable('agent_run').set({ usage: JSON.stringify(usage) }).where('id', '=', runId).compile()
		]);
	}
	const endable = await loadEndableRun(db, run.user_id, runId);
	if (endable) {
		await endRun(db, env, endable, { status: body.status, error: error ?? null, now });
	}
	return serializedRun(db, run.user_id, runId);
}
