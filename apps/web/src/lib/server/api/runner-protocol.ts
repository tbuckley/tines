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
	RUN_LOG_RAW_MAX_BYTES,
	type AgentRun,
	type AgentRunUsage,
	type CodexPricingEvidenceV1,
	type AppendRunLogResponse,
	type FinishRunRequest,
	type Runner,
	type RunnerAssignment,
	type RunnerAssignmentResume,
	type RunnerPollRequest,
	type RunnerPollResponse,
	type EffortCapabilities,
	isEffortToken,
	EFFORT_CAPABILITIES_MAX_BYTES,
	EFFORT_CAPABILITIES_MAX_EFFORTS,
	EFFORT_CAPABILITIES_MAX_MODELS
} from '@tines/shared';
import type { RequestEvent } from '@sveltejs/kit';
import { sql, type Kysely } from 'kysely';
import { sha256Hex } from '$lib/server/crypto';
import { getDb, newId, type Database } from '$lib/server/db';
import {
	endRun,
	loadEndableRun,
	markRunRunning,
	mintRunKeyAndFlip,
	noteInterruption,
	noteRateLimit,
	supervisorEvent
} from '$lib/server/supervisor/engine';
import { getRunLogStore, runLogRawKey } from '$lib/server/run-log-store';
import { spillEvicted } from '$lib/server/supervisor/run-log';
import { appendLogTail } from '$lib/server/supervisor/logic';
import { buildResumePreamble, buildSupervisorPreamble } from '$lib/server/supervisor/preamble';
import {
	claimResumeResource,
	findResumeResource,
	isResumeProviderSupported,
	resumeEligibility,
	resumeFingerprint,
	retainResumeResource
} from '$lib/server/supervisor/resume';
import { effectiveAutomationEnabled } from '$lib/server/supervisor/settings';
import { priceCodexUsage } from '$lib/server/supervisor/codex-pricing';
import { listArtifacts } from './artifacts';
import { listLabels } from './labels';
import { buildLaunchPrompt, buildResumePrompt, effectiveContextForIssue } from './context';
import { ApiFail, notFound, optionalString, runAtomic } from './core';
import { requestDispatchEffects } from './core';
import type { DispatchEffects } from '$lib/server/dispatch-effects';
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
): Promise<{ db: Kysely<Database>; env: Env; runner: RunnerRow; effects: DispatchEffects }> {
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
	return {
		db,
		env: event.platform.env,
		runner,
		effects: requestDispatchEffects(event, runner.user_id)
	};
}

async function serializedRun(
	db: Kysely<Database>,
	userId: string,
	runId: string
): Promise<AgentRun> {
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
	/**
	 * True when `owned_runs` reconciliation interrupted at least one run.
	 * Those runs' issues take no strike and re-enter the pool immediately, so
	 * queue a pass rather than making a restarted daemon wait out the cron.
	 */
	reconciled: boolean;
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

function validateInstanceId(body: RunnerPollRequest): string | undefined {
	const instanceId = body.instance_id;
	if (instanceId === undefined) return undefined;
	if (
		typeof instanceId !== 'string' ||
		instanceId.length < 1 ||
		instanceId.length > 128 ||
		!/^[A-Za-z0-9_-]+$/.test(instanceId)
	) {
		throw new ApiFail(
			422,
			'invalid_field',
			'"instance_id" must be 1–128 ASCII letters, digits, underscores, or hyphens',
			{ field: 'instance_id' }
		);
	}
	return instanceId;
}

/** Validate and bound the daemon assertion before it reaches durable state. */
export function validateEffortCapabilities(
	value: unknown,
	instanceId?: string
): EffortCapabilities | null {
	if (value === undefined) return null;
	if (!instanceId) {
		throw new ApiFail(422, 'invalid_field', '"effort_capabilities" requires "instance_id"', {
			field: 'effort_capabilities'
		});
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new ApiFail(422, 'invalid_field', '"effort_capabilities" must be an object', {
			field: 'effort_capabilities'
		});
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		throw new ApiFail(422, 'invalid_field', '"effort_capabilities" must be JSON serializable');
	}
	if (new TextEncoder().encode(encoded).length > EFFORT_CAPABILITIES_MAX_BYTES)
		throw new ApiFail(422, 'invalid_field', '"effort_capabilities" exceeds 64 KiB', {
			field: 'effort_capabilities'
		});
	const raw = value as Record<string, unknown>;
	if (raw.version !== 1) {
		if (!Number.isInteger(raw.version) || typeof raw.reason !== 'string' || raw.reason.length > 200)
			throw new ApiFail(
				422,
				'invalid_field',
				'unsupported capability versions require a bounded reason',
				{
					field: 'effort_capabilities'
				}
			);
		return { version: raw.version as number, reason: raw.reason };
	}
	if (
		(raw.harness !== 'claude_code' && raw.harness !== 'codex') ||
		typeof raw.daemon_version !== 'string' ||
		raw.daemon_version.length > 100 ||
		typeof raw.harness_version !== 'string' ||
		raw.harness_version.length > 100 ||
		typeof raw.catalog_digest !== 'string' ||
		raw.catalog_digest.length > 100 ||
		!Array.isArray(raw.models) ||
		raw.models.length > EFFORT_CAPABILITIES_MAX_MODELS
	) {
		throw new ApiFail(422, 'invalid_field', 'malformed V1 effort capability report', {
			field: 'effort_capabilities'
		});
	}
	const models = raw.models as Array<Record<string, unknown>>;
	const names = new Set<string>();
	for (const model of models) {
		if (
			typeof model.model !== 'string' ||
			model.model.length < 1 ||
			model.model.length > 200 ||
			names.has(model.model) ||
			!Array.isArray(model.efforts) ||
			model.efforts.length > EFFORT_CAPABILITIES_MAX_EFFORTS ||
			model.efforts.some((effort) => !isEffortToken(effort)) ||
			new Set(model.efforts).size !== model.efforts.length
		) {
			throw new ApiFail(422, 'invalid_field', 'malformed V1 model effort capability', {
				field: 'effort_capabilities.models'
			});
		}
		names.add(model.model);
	}
	return value as EffortCapabilities;
}

async function admitDaemonInstance(
	db: Kysely<Database>,
	env: Env,
	runner: RunnerRow,
	instanceId: string,
	now: number
): Promise<RunnerRow> {
	const mayReplace = sql<boolean>`EXISTS (
		SELECT 1 FROM runner
		WHERE id = ${runner.id}
			AND daemon_instance_id IS NOT NULL
			AND daemon_instance_id IS NOT ${instanceId}
			AND fenced_instance_id IS NOT ${instanceId}
	)`;
	const results = await runAtomic(env, [
		supervisorEvent(
			db,
			runner.user_id,
			{
				type: 'runner.daemon_replaced',
				payload: { runner_id: runner.id, name: runner.name }
			},
			now,
			mayReplace
		),
		db
			.updateTable('runner')
			.set({
				fenced_instance_id: sql<string | null>`CASE
					WHEN daemon_instance_id IS NOT ${instanceId} THEN daemon_instance_id
					ELSE fenced_instance_id
				END`,
				daemon_instance_id: instanceId
			})
			.where('id', '=', runner.id)
			.where(sql<boolean>`fenced_instance_id IS NOT ${instanceId}`)
			.compile(),
		db
			.selectFrom('runner')
			.selectAll()
			.where('id', '=', runner.id)
			.where('daemon_instance_id', '=', instanceId)
			.compile()
	]);
	const admitted = results[2]?.results?.[0] as RunnerRow | undefined;
	if (admitted) return admitted;
	const exists = await db
		.selectFrom('runner')
		.select('id')
		.where('id', '=', runner.id)
		.executeTakeFirst();
	if (!exists) throw notFound();
	throw new ApiFail(
		409,
		'runner_conflict',
		'another daemon instance is serving this runner; this one has been superseded'
	);
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
	effects: DispatchEffects,
	body: RunnerPollRequest,
	now: number = Date.now()
): Promise<PollOutcome> {
	const owned = new Set(validateOwnedRuns(body));
	const instanceId = validateInstanceId(body);
	const effortCapabilities = validateEffortCapabilities(body.effort_capabilities, instanceId);
	const requestedCap =
		body.max_concurrent === undefined
			? undefined
			: validateBoundedInt(body.max_concurrent, 'max_concurrent', 1, 100);
	if (body.draining !== undefined && typeof body.draining !== 'boolean') {
		throw new ApiFail(422, 'invalid_field', '"draining" must be a boolean', { field: 'draining' });
	}
	if (instanceId !== undefined)
		runner = await admitDaemonInstance(db, env, runner, instanceId, now);
	const cap = requestedCap === undefined ? runner.max_concurrent : requestedCap;
	const capChanged = cap !== runner.max_concurrent;
	// Every poll states the flag, so a daemon that died mid-drain cannot pin
	// the runner shut: its relaunch (or any older daemon) polls without it.
	const draining = body.draining === true ? 1 : 0;
	// Leaving the drain is capacity coming back, exactly like a raised cap:
	// the runner took nothing new while it drained, so work may be waiting.
	const capRaised = cap > runner.max_concurrent || (runner.draining === 1 && draining === 0);
	const cameOnline =
		runner.last_seen_at === null || now - runner.last_seen_at > RUNNER_ONLINE_WINDOW_MS;
	const heartbeatResults = await runAtomic(env, [
		db
			.updateTable('runner')
			.set({
				last_seen_at: now,
				draining,
				effort_capabilities: effortCapabilities ? JSON.stringify(effortCapabilities) : null,
				...(capChanged ? { max_concurrent: cap, updated_at: now } : {})
			})
			.where('id', '=', runner.id)
			.$if(instanceId !== undefined, (query) => query.where('daemon_instance_id', '=', instanceId!))
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
	if (instanceId !== undefined && (heartbeatResults[0]?.meta.changes ?? 0) === 0) {
		throw new ApiFail(
			409,
			'runner_conflict',
			'another daemon instance replaced this one before its capability report was stored'
		);
	}
	if (cameOnline || capRaised) effects.signalDispatch();
	runner.max_concurrent = cap;
	runner.draining = draining;
	runner.effort_capabilities = effortCapabilities ? JSON.stringify(effortCapabilities) : null;

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
	const lostError = 'lost by daemon (missing from owned_runs)';
	let reconciled = false;
	for (const run of active) {
		if (run.status !== 'running' || owned.has(run.id)) continue;
		const endable = await loadEndableRun(db, run.user_id, run.id);
		if (!endable || endable.status !== 'running') continue;
		// The daemon lost the run, the agent did not fail it: `interrupted`,
		// so the issue keeps its attempt budget and simply gets re-dispatched.
		const ended = await endRun(db, env, endable, {
			status: 'failed',
			error: lostError,
			judgment: 'interrupted',
			now
		});
		if (ended.outcome === 'interrupted') {
			reconciled = true;
			effects.signalDispatch();
		}
	}
	// One incident, one increment: a daemon that came back having dropped
	// five runs is one failure, not five (noteInterruption's backoff window
	// would collapse them anyway; calling once keeps the intent legible).
	if (reconciled) {
		await noteInterruption(db, env, {
			userId: runner.user_id,
			runnerId: runner.id,
			error: lostError,
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

	// A draining runner still receives runs it already claimed: they hold
	// their claim and key, and the daemon finishes them before it exits.
	// Only the dispatcher's next claim is withheld (targetVerdict).
	const assignments: RunnerAssignment[] = [];
	if (runner.status === 'active') {
		for (const run of active) {
			if (run.status !== 'assigned') continue;
			const assignment = await deliverAssignedRun(db, env, runner, run, now);
			if (assignment) assignments.push(assignment);
		}
	}

	return { response: { assignments, cancels }, cameOnline, capRaised, reconciled };
}

/**
 * One-shot delivery of one `assigned` run. Launch materials are assembled
 * here — at poll-delivery, never claim time — and if the issue is no longer
 * eligible (transitioned away from the state the claim routed for, parked,
 * or automation disarmed) the assignment is canceled instead of delivered:
 * the issue re-enters the pool and routing re-evaluates. Null = nothing to
 * deliver (canceled here, or another poll won the flip).
 */
/** A runner's config column as an object; an unreadable one reads as empty. */
function parseRunnerConfig(raw: string): Record<string, unknown> {
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {};
	}
}

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
		effectiveAutomationEnabled(settings?.enabled);
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

	const [issue, bundle, artifacts, labels] = await Promise.all([
		getIssueDetail(db, run.user_id, { id: run.issue_id }, { round: true }),
		effectiveContextForIssue(db, run.user_id, run.issue_id),
		listArtifacts(db, run.user_id, run.issue_id),
		listLabels(db, run.user_id)
	]);
	const issueRef = `${issue.project_name}/${issue.number}`;

	// Continuation, when the previous run on this runner left a live session
	// for this issue and every guard passes. A failure anywhere here — an
	// ineligible candidate, a lost claim race — falls through to the fresh
	// launch below, which is the path this runner has always taken.
	const resume = await prepareResume(db, env, { runner, run, now });
	if (resume) {
		const preamble = buildResumePreamble({
			variant: 'local',
			runId: run.id,
			runnerName: runner.name,
			issueRef,
			timeoutMinutes: runner.max_run_minutes,
			previousRunId: resume.previous_run_id
		});
		return {
			run: await serializedRun(db, run.user_id, run.id),
			...(run.resolved_effort && run.effort_source && run.effort_application_status === 'pending'
				? {
						effort: {
							version: 1 as const,
							value: run.resolved_effort,
							source: JSON.parse(run.effort_source)
						}
					}
				: {}),
			prompt: `${preamble}\n\n${buildResumePrompt(
				bundle,
				issue,
				artifacts,
				labels.map((l) => l.name)
			)}`,
			bundle,
			run_key: minted.secret,
			timeout_minutes: runner.max_run_minutes,
			resume
		};
	}
	const preamble = buildSupervisorPreamble({
		variant: 'local',
		runId: run.id,
		runnerName: runner.name,
		issueRef,
		timeoutMinutes: runner.max_run_minutes
	});
	return {
		run: await serializedRun(db, run.user_id, run.id),
		...(run.resolved_effort && run.effort_source && run.effort_application_status === 'pending'
			? {
					effort: {
						version: 1 as const,
						value: run.resolved_effort,
						source: JSON.parse(run.effort_source)
					}
				}
			: {}),
		prompt: `${preamble}\n\n${buildLaunchPrompt(
			bundle,
			issue,
			artifacts,
			labels.map((l) => l.name)
		)}`,
		bundle,
		run_key: minted.secret,
		timeout_minutes: runner.max_run_minutes
	};
}

/**
 * The resume decision at delivery. Reads the newest ended run for this issue
 * on this runner, its retained resource and the runner's policy, runs the
 * pure eligibility check, and — only when it passes — claims the resource so
 * the GC cannot dispose it underneath the launch. Records the outcome on the
 * run either way: `resumed_from_run_id` and `resume_expires_at` on a resume,
 * `resume_fallback_reason` on a decline, so `tines runs list` can say why a
 * send-back launched cold.
 *
 * Returns null for "launch fresh", which is always safe: nothing about the
 * fresh path depends on any of this.
 */
async function prepareResume(
	db: Kysely<Database>,
	env: Env,
	input: { runner: RunnerRow; run: Database['agent_run']; now: number }
): Promise<RunnerAssignmentResume | null> {
	const { runner, run, now } = input;
	const config = parseRunnerConfig(runner.config);
	if (!runner.resume_enabled || !isResumeProviderSupported(runner.type as Runner['type'], config)) {
		return null;
	}
	const predecessor = await db
		.selectFrom('agent_run')
		.select([
			'id',
			'runner_id',
			'ended_at',
			'outcome',
			'conversation_turn_count',
			'state_id_at_end',
			'api_key_id'
		])
		.where('user_id', '=', run.user_id)
		.where('issue_id', '=', run.issue_id)
		.where('ended_at', 'is not', null)
		.where('id', '!=', run.id)
		.orderBy('ended_at desc')
		.orderBy('id desc')
		.executeTakeFirst();
	if (!predecessor) return null;

	const [resource, endState] = await Promise.all([
		findResumeResource(db, {
			userId: run.user_id,
			runnerId: runner.id,
			issueId: run.issue_id
		}),
		predecessor.state_id_at_end
			? db
					.selectFrom('workflow_state')
					.select('category')
					.where('id', '=', predecessor.state_id_at_end)
					.executeTakeFirst()
			: Promise.resolve(undefined)
	]);
	const fingerprint = resumeFingerprint({
		runnerId: runner.id,
		harness: String(config.harness ?? 'claude_code'),
		model: run.model,
		effort: run.effort_application_status === 'pending' ? run.resolved_effort : null,
		preambleVariant: 'local'
	});
	const verdict = resumeEligibility({
		now,
		runner: {
			id: runner.id,
			type: runner.type as Runner['type'],
			config,
			resume_enabled: true,
			resume_window_hours: runner.resume_window_hours,
			resume_max_turns: runner.resume_max_turns,
			resume_max_tokens: runner.resume_max_tokens,
			resume_max_cost_usd: runner.resume_max_cost_usd
		},
		predecessor,
		conversation_usage: null,
		resource: resource ?? null,
		newest_ended_run_id: predecessor.id,
		ended_in_awaiting_state: endState?.category === 'awaiting_human',
		// The resource only exists because the owning run advanced its issue
		// itself; `outcome === 'advanced'` above is that same authorship.
		last_transition_authored_by_run: predecessor.outcome === 'advanced',
		expected_fingerprint: fingerprint
	});
	if (!verdict.eligible) {
		// Only worth recording when there was something to decline: an issue
		// this runner has never held an awaiting session for is not a fallback.
		if (resource) {
			await runAtomic(env, [
				db
					.updateTable('agent_run')
					.set({ resume_fallback_reason: verdict.reason })
					.where('id', '=', run.id)
					.compile()
			]);
		}
		return null;
	}
	const claimed = await claimResumeResource(db, {
		resourceId: resource!.id,
		ownerRunId: predecessor.id,
		claimRunId: run.id,
		claimToken: run.id,
		now
	});
	if (!claimed) return null;
	await runAtomic(env, [
		db
			.updateTable('agent_run')
			// Lineage only. `resume_expires_at` means "this run's own workspace
			// and session are being held" — the daemon keeps the workspace on
			// exactly that signal — so a run that merely *inherited* a
			// predecessor's workspace must not carry it, or a resumed run that
			// then fails would keep a workspace nothing retained.
			.set({
				resumed_from_run_id: predecessor.id,
				workspace_path: resource!.workspace_path
			})
			.where('id', '=', run.id)
			.compile()
	]);
	return {
		previous_run_id: predecessor.id,
		provider_session_id: resource!.provider_session_id!,
		workspace_path: resource!.workspace_path!,
		prior_turn_count: predecessor.conversation_turn_count ?? 0
	};
}

// ---------------------------------------------------------------------------
// Log append: 256 KB tail, truncated from the head (appendLogTail lives in
// supervisor/logic.ts so the sweep's managed-run polling shares it)

export { appendLogTail };

/**
 * `PUT /api/v1/runs/:id/log/raw`: stores the raw harness stream for a run.
 *
 * Streamed straight into the bucket rather than buffered — these run to tens
 * of megabytes and a Worker has no room to hold one. R2 needs the length up
 * front, so the daemon must send `Content-Length`; the daemon is also the
 * one that truncates to the cap (keeping the tail), and a body claiming more
 * than the cap is rejected outright.
 */
export async function uploadRawRunLog(
	db: Kysely<Database>,
	env: Env,
	runner: RunnerRow,
	runId: string,
	request: Request
): Promise<{ log_raw_bytes: number }> {
	const run = await loadRunnerRun(db, runner, runId);
	if (run.log_objects_deleted_at !== null) {
		throw new ApiFail(409, 'log_expired', "This run's logs have passed their retention window");
	}
	const declared = Number(request.headers.get('content-length'));
	if (!Number.isInteger(declared) || declared <= 0) {
		throw new ApiFail(
			411,
			'length_required',
			'A Content-Length header is required for a raw log upload'
		);
	}
	if (declared > RUN_LOG_RAW_MAX_BYTES) {
		throw new ApiFail(
			413,
			'log_too_large',
			`The raw log must be at most ${RUN_LOG_RAW_MAX_BYTES} bytes`
		);
	}
	const body = request.body;
	if (!body) throw new ApiFail(422, 'invalid_body', 'The request had no body');
	await getRunLogStore(env).put(
		runLogRawKey(run.user_id, run.id),
		body as ReadableStream<Uint8Array>,
		declared
	);
	await runAtomic(env, [
		db.updateTable('agent_run').set({ log_raw_bytes: declared }).where('id', '=', runId).compile()
	]);
	return { log_raw_bytes: declared };
}

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
	seq?: unknown,
	effortApplication?: import('@tines/shared').AppendRunLogRequest['effort_application']
): Promise<AppendRunLogResponse> {
	if (typeof chunk !== 'string' || chunk.length > 1_000_000) {
		throw new ApiFail(
			422,
			'invalid_field',
			'"chunk" must be a string of at most 1,000,000 characters',
			{
				field: 'chunk'
			}
		);
	}
	if (seq !== undefined && (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1)) {
		throw new ApiFail(422, 'invalid_field', '"seq" must be a positive integer', { field: 'seq' });
	}
	const run = await loadRunnerRun(db, runner, runId);
	if (
		effortApplication &&
		((effortApplication.status !== 'accepted_unconfirmed' &&
			effortApplication.status !== 'rejected') ||
			effortApplication.transport !== 'argv' ||
			effortApplication.attempted_effort !== run.resolved_effort ||
			(effortApplication.reason !== undefined &&
				(typeof effortApplication.reason !== 'string' || effortApplication.reason.length > 500)))
	) {
		throw new ApiFail(422, 'invalid_field', 'effort application does not match the claimed run', {
			field: 'effort_application'
		});
	}
	if (run.status === 'assigned') {
		throw new ApiFail(
			422,
			'run_not_delivered',
			'This run has not been delivered to the daemon yet'
		);
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
	// The update is guarded on `log_part_count`, so it can lose. Acking a
	// chunk whose write did not land would drop those bytes for good — the
	// daemon has been told they are safe and never resends — so a lost guard
	// re-reads and retries once rather than returning.
	let current = run;
	for (let attempt = 0; ; attempt++) {
		const appended = appendLogTail(current.log, current.log_bytes_dropped, chunk);
		// Bytes the tail evicts go to R2 *before* the D1 update, so D1 never
		// records dropped bytes that no object holds. The reverse — an object
		// whose update then loses a guard — is an orphan the sweep GCs.
		const spill = appended.evicted ? await spillEvicted(env, current, appended.evicted) : null;
		const results = await runAtomic(env, [
			db
				.updateTable('agent_run')
				.set({
					log: appended.log,
					log_bytes_dropped: appended.dropped,
					...(spill ?? {}),
					...(seq === undefined ? {} : { log_seq: seq }),
					...(effortApplication
						? {
								effort_application_status: effortApplication.status,
								effort_application_evidence: JSON.stringify({
									version: 1,
									transport: effortApplication.transport,
									attempted_effort: effortApplication.attempted_effort,
									received_at: now,
									...(effortApplication.reason ? { reason: effortApplication.reason } : {})
								})
							}
						: {})
				})
				.where('id', '=', runId)
				// A chunk racing a cancel/sweep must not extend a settled run's
				// tail: the active check above was a read, this is the guard.
				.where('status', 'in', ACTIVE)
				// …and a concurrent append must not clobber this one's part
				// bookkeeping: both would claim the same part index.
				.where('log_part_count', '=', current.log_part_count)
				.compile()
		]);
		if ((results[0]?.meta.changes ?? 0) > 0) {
			return {
				status:
					current.status === 'launching'
						? 'running'
						: (current.status as AppendRunLogResponse['status']),
				log_bytes_dropped: appended.dropped,
				log_seq: seq ?? current.log_seq
			};
		}
		current = await loadRunnerRun(db, runner, runId);
		if (!(ACTIVE as string[]).includes(current.status)) {
			throw new ApiFail(422, 'run_already_ended', 'This run has already ended; the log is closed');
		}
		// A concurrent append that carried this same seq already applied it.
		if (seq !== undefined && seq <= current.log_seq) {
			return {
				status: current.status as AppendRunLogResponse['status'],
				log_bytes_dropped: current.log_bytes_dropped,
				log_seq: current.log_seq
			};
		}
		if (attempt >= 1) {
			throw new ApiFail(
				409,
				'log_append_conflict',
				'Another append raced this one twice; resend this chunk'
			);
		}
	}
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
		if (
			typeof raw[field] !== 'number' ||
			!Number.isFinite(raw[field]) ||
			(raw[field] as number) < 0
		) {
			throw new ApiFail(422, 'invalid_field', `"usage.${field}" must be a non-negative number`, {
				field: `usage.${field}`
			});
		}
		usage[field] = raw[field] as number;
	}
	if (raw.cost_source !== undefined) {
		if (!['provider', 'priced', 'none'].includes(raw.cost_source as string)) {
			throw new ApiFail(
				422,
				'invalid_field',
				'"usage.cost_source" must be provider, priced, or none',
				{
					field: 'usage.cost_source'
				}
			);
		}
		usage.cost_source = raw.cost_source as AgentRunUsage['cost_source'];
	}
	return usage;
}

function validatePricingEvidence(value: unknown): {
	evidence?: CodexPricingEvidenceV1;
	valid: boolean;
} {
	if (value === undefined || value === null) return { valid: true };
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new ApiFail(422, 'invalid_field', '"pricing_evidence" must be an object', {
			field: 'pricing_evidence'
		});
	}
	const raw = value as Record<string, unknown>;
	const malformedRequestContext = (): NonNullable<CodexPricingEvidenceV1['request_context']> => ({
		version: 1,
		normalization: 'codex-rollout-delta-v1',
		status: 'invalid',
		reason: 'malformed'
	});
	const sanitizeRequestContext = (
		value: unknown
	): CodexPricingEvidenceV1['request_context'] | undefined => {
		if (value === undefined) return;
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return malformedRequestContext();
		const item = value as Record<string, unknown>;
		const harnessVersion =
			typeof item.harness_version === 'string' &&
			item.harness_version.length > 0 &&
			item.harness_version.length <= 100 &&
			!/[\x00-\x1f\x7f]/.test(item.harness_version)
				? item.harness_version
				: undefined;
		if (item.version !== 1)
			return {
				version: 1,
				normalization: 'codex-rollout-delta-v1',
				...(harnessVersion ? { harness_version: harnessVersion } : {}),
				status: 'unsupported',
				reason: 'unsupported_version'
			};
		if (item.normalization !== 'codex-rollout-delta-v1') return malformedRequestContext();
		if (item.status === 'complete') {
			if (
				harnessVersion !== '0.153.4' ||
				!Number.isSafeInteger(item.request_count) ||
				(item.request_count as number) < 0 ||
				!Number.isSafeInteger(item.max_request_input_tokens) ||
				(item.max_request_input_tokens as number) < 0 ||
				!item.reconciled_usage ||
				typeof item.reconciled_usage !== 'object' ||
				Array.isArray(item.reconciled_usage)
			)
				return malformedRequestContext();
			const reconciled = item.reconciled_usage as Record<string, unknown>;
			const copied = {} as Required<NonNullable<CodexPricingEvidenceV1['raw_usage']>>;
			for (const field of [
				'input_tokens',
				'cached_input_tokens',
				'cache_write_input_tokens',
				'output_tokens'
			] as const) {
				if (!Number.isSafeInteger(reconciled[field]) || (reconciled[field] as number) < 0)
					return malformedRequestContext();
				copied[field] = reconciled[field] as number;
			}
			return {
				version: 1,
				normalization: 'codex-rollout-delta-v1',
				harness_version: '0.153.4',
				status: 'complete',
				request_count: item.request_count as number,
				max_request_input_tokens: item.max_request_input_tokens as number,
				reconciled_usage: copied
			};
		}
		const reasons = [
			'not_applicable',
			'thread_id_missing',
			'rollout_missing',
			'rollout_ambiguous',
			'unsafe_path',
			'read_failed',
			'limit_exceeded',
			'unsupported_version',
			'metadata_mismatch',
			'malformed',
			'missing_dimension',
			'nonmonotonic',
			'delta_mismatch',
			'terminal_mismatch',
			'model_mismatch'
		] as const;
		if (
			!['unavailable', 'unsupported', 'invalid'].includes(item.status as string) ||
			!reasons.includes(item.reason as (typeof reasons)[number])
		)
			return malformedRequestContext();
		return {
			version: 1,
			normalization: 'codex-rollout-delta-v1',
			...(harnessVersion ? { harness_version: harnessVersion } : {}),
			status: item.status as 'unavailable' | 'unsupported' | 'invalid',
			reason: item.reason as (typeof reasons)[number]
		};
	};
	const short = (field: string, max: number, nullable = false): string | null => {
		const item = raw[field];
		if (nullable && item === null) return null;
		if (
			typeof item !== 'string' ||
			item.length < 1 ||
			item.length > max ||
			/[\x00-\x1f\x7f]/.test(item)
		) {
			throw new ApiFail(
				422,
				'invalid_field',
				`"pricing_evidence.${field}" must be a short string`,
				{ field: `pricing_evidence.${field}` }
			);
		}
		return item;
	};
	const model = short('model', 255, true);
	const daemonVersion =
		raw.daemon_version === undefined ? undefined : (short('daemon_version', 100) as string);
	const requestContext = sanitizeRequestContext(raw.request_context);
	let rawUsage: CodexPricingEvidenceV1['raw_usage'];
	if (raw.raw_usage !== undefined) {
		if (
			raw.raw_usage === null ||
			typeof raw.raw_usage !== 'object' ||
			Array.isArray(raw.raw_usage)
		) {
			throw new ApiFail(422, 'invalid_field', '"pricing_evidence.raw_usage" must be an object', {
				field: 'pricing_evidence.raw_usage'
			});
		}
		rawUsage = {};
		for (const field of [
			'input_tokens',
			'cached_input_tokens',
			'cache_write_input_tokens',
			'output_tokens'
		] as const) {
			const metric = (raw.raw_usage as Record<string, unknown>)[field];
			if (metric === undefined) continue;
			if (!Number.isSafeInteger(metric) || (metric as number) < 0) {
				throw new ApiFail(
					422,
					'invalid_field',
					`"pricing_evidence.raw_usage.${field}" must be a non-negative safe integer`,
					{ field: `pricing_evidence.raw_usage.${field}` }
				);
			}
			rawUsage[field] = metric as number;
		}
	}
	if (!Number.isSafeInteger(raw.terminal_snapshots) || (raw.terminal_snapshots as number) < 0) {
		throw new ApiFail(
			422,
			'invalid_field',
			'"pricing_evidence.terminal_snapshots" must be a non-negative safe integer',
			{ field: 'pricing_evidence.terminal_snapshots' }
		);
	}
	if (typeof raw.model_rerouted !== 'boolean') {
		throw new ApiFail(422, 'invalid_field', '"pricing_evidence.model_rerouted" must be boolean', {
			field: 'pricing_evidence.model_rerouted'
		});
	}
	const measurements = [
		'complete',
		'missing',
		'invalid',
		'nonmonotonic',
		'incomplete_attempt',
		'multiple_threads'
	] as const;
	const valid =
		raw.version === 1 &&
		raw.harness === 'codex' &&
		raw.identity_source === 'launch_argument' &&
		raw.usage_scope === 'thread_total' &&
		['cold', 'resumed'].includes(raw.session_mode as string) &&
		raw.normalization === 'codex-jsonl-v1' &&
		measurements.includes(raw.measurement_status as (typeof measurements)[number]);
	if (!valid) return { valid: false };
	return {
		valid: true,
		evidence: {
			version: 1,
			harness: 'codex',
			model,
			identity_source: 'launch_argument',
			usage_scope: 'thread_total',
			session_mode: raw.session_mode as 'cold' | 'resumed',
			normalization: 'codex-jsonl-v1',
			...(rawUsage ? { raw_usage: rawUsage } : {}),
			model_rerouted: raw.model_rerouted,
			measurement_status: raw.measurement_status as CodexPricingEvidenceV1['measurement_status'],
			terminal_snapshots: raw.terminal_snapshots as number,
			...(daemonVersion ? { daemon_version: daemonVersion } : {}),
			...(requestContext ? { request_context: requestContext } : {})
		}
	};
}

function validateProviderSessionId(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== 'string' ||
		value.length < 1 ||
		value.length > 255 ||
		!value.trim() ||
		/[\x00-\x1f\x7f]/.test(value)
	) {
		throw new ApiFail(422, 'invalid_field', '"provider_session_id" must be a short opaque string', {
			field: 'provider_session_id'
		});
	}
	return value;
}

function validateTurnCount(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000) {
		throw new ApiFail(422, 'invalid_field', `"${field}" must be a non-negative integer`, { field });
	}
	return value;
}

/**
 * Retention: a run that advanced its issue into an awaiting state on a
 * resume-enabled runner leaves its session and workspace claimable until the
 * window closes. Everything here is best-effort — a missing session id, a
 * workspace the daemon did not report, a runner that is not opted in, or an
 * issue that landed anywhere but an awaiting state simply retains nothing,
 * and the next dispatch launches fresh as it always has.
 */
async function retainAwaitingSession(
	db: Kysely<Database>,
	runner: RunnerRow,
	input: {
		run: { user_id: string; issue_id: string; model: string | null };
		runId: string;
		providerSessionId: string | null;
		workspacePath: string | null;
		now: number;
	}
): Promise<void> {
	const config = parseRunnerConfig(runner.config);
	if (
		!runner.resume_enabled ||
		!isResumeProviderSupported(runner.type as Runner['type'], config) ||
		!input.providerSessionId ||
		!input.workspacePath
	) {
		return;
	}
	const ended = await db
		.selectFrom('agent_run')
		.innerJoin('workflow_state as st', 'st.id', 'agent_run.state_id_at_end')
		.select(['st.category'])
		.where('agent_run.id', '=', input.runId)
		.executeTakeFirst();
	if (ended?.category !== 'awaiting_human') return;
	await retainResumeResource(db, {
		id: newId('rres'),
		userId: input.run.user_id,
		runnerId: runner.id,
		issueId: input.run.issue_id,
		ownerRunId: input.runId,
		providerSessionId: input.providerSessionId,
		workspacePath: input.workspacePath,
		fingerprint: resumeFingerprint({
			runnerId: runner.id,
			harness: String(config.harness ?? 'claude_code'),
			model: input.run.model,
			preambleVariant: 'local'
		}),
		expiresAt: input.now + runner.resume_window_hours * 60 * 60 * 1000,
		now: input.now
	});
	await db
		.updateTable('agent_run')
		.set({ resume_expires_at: input.now + runner.resume_window_hours * 60 * 60 * 1000 })
		.where('id', '=', input.runId)
		.execute();
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
	effects: DispatchEffects,
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
	let usage = validateUsage(body.usage);
	const pricingEvidence = validatePricingEvidence(body.pricing_evidence);
	const providerSessionId = validateProviderSessionId(body.provider_session_id);
	const turnCount = validateTurnCount(body.turn_count, 'turn_count');
	const conversationTurnCount = validateTurnCount(
		body.conversation_turn_count,
		'conversation_turn_count'
	);
	const workspacePath = optionalString(body.workspace_path, 'workspace_path', { max: 1024 });
	if (
		body.resume_at !== undefined &&
		(typeof body.resume_at !== 'number' || !Number.isFinite(body.resume_at))
	) {
		throw new ApiFail(422, 'invalid_field', '"resume_at" must be a number (epoch ms)', {
			field: 'resume_at'
		});
	}

	const run = await loadRunnerRun(db, runner, runId);
	if (run.status === 'assigned') {
		throw new ApiFail(
			422,
			'run_not_delivered',
			'This run has not been delivered to the daemon yet'
		);
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
	if (usage && (pricingEvidence.evidence || body.pricing_evidence !== undefined)) {
		usage =
			!pricingEvidence.valid && usage.cost_source === 'provider' && usage.cost_usd !== undefined
				? { ...usage, pricing: { version: 1, evaluated_at: now, status: 'provider_authoritative' } }
				: pricingEvidence.valid
					? priceCodexUsage({ run, usage, evidence: pricingEvidence.evidence, now })
					: {
							...usage,
							cost_usd: undefined,
							cost_source: 'priced',
							pricing: {
								version: 1,
								evaluated_at: now,
								status: 'unpriced',
								reason: 'invalid_pricing_evidence'
							}
						};
	} else if (usage) usage = priceCodexUsage({ run, usage, now });
	// The daemon marks the ends it knows were its own fault — a shutdown, an
	// orphan killed after a restart — as interruptions. Honoured only on a
	// failure, and only for that exact value: everything else (a harness
	// exiting non-zero, a workspace that would not clone) is the run failing
	// and still strikes. Absent, as from any daemon predating the field, is
	// judged exactly as before.
	//
	// `rate_limited` is the same judgment with a cause: the harness's provider
	// refused the work outright, so the run is no more the issue's fault than a
	// shutdown is — but the *runner* must stop asking until the window resets.
	const judgment =
		body.status === 'failed' &&
		(body.judgment === 'interrupted' || body.judgment === 'rate_limited')
			? body.judgment
			: undefined;
	const endable = await loadEndableRun(db, run.user_id, runId);
	if (endable) {
		const ended = await endRun(db, env, endable, {
			status: body.status,
			error: error ?? null,
			...(judgment ? { judgment: 'interrupted' as const } : {}),
			finalReport: {
				...(usage ? { usage: JSON.stringify(usage) } : {}),
				...(providerSessionId ? { provider_session_id: providerSessionId } : {}),
				...(turnCount !== undefined ? { turn_count: turnCount } : {}),
				...(conversationTurnCount !== undefined
					? { conversation_turn_count: conversationTurnCount }
					: turnCount !== undefined
						? { conversation_turn_count: turnCount }
						: {}),
				...(workspacePath ? { workspace_path: workspacePath } : {})
			},
			now
		});
		if (ended.ended) effects.signalDispatch();
		if (judgment === 'rate_limited' && ended.ended) {
			// On `ended`, not on the outcome: an agent that transitioned the
			// issue before hitting the wall leaves an `advanced` run, and the
			// runner is rate-limited all the same.
			await noteRateLimit(db, env, {
				userId: run.user_id,
				runnerId: run.runner_id,
				runId,
				error: error ?? 'harness reported a usage limit',
				resumeAt: body.resume_at ?? null,
				limit: null,
				now
			});
		} else if (ended.outcome === 'interrupted') {
			// A daemon that keeps dying mid-run backs off, the same as one that
			// keeps failing to launch; the window collapses a shutdown's burst of
			// finish reports into one incident.
			await noteInterruption(db, env, {
				userId: run.user_id,
				runnerId: run.runner_id,
				runId,
				error: error ?? 'run interrupted by the daemon',
				now
			});
		} else if (ended.outcome === 'advanced' && ended.ended) {
			// One chain, not two ifs: a `rate_limited` finish is passed to
			// `endRun` as `interrupted`, so a separate interruption arm would
			// double-notify it — the runner is already held to the reset.
			await retainAwaitingSession(db, runner, {
				run,
				runId,
				providerSessionId: providerSessionId ?? run.provider_session_id ?? null,
				workspacePath: workspacePath ?? null,
				now
			});
		}
	}
	return serializedRun(db, run.user_id, runId);
}
