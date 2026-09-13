/**
 * The dispatch engine: eligibility, routing, the guarded claim, launching
 * through the adapter interface, end judgment (strikes / parking), the
 * launch-failure backoff, and the supervisor sweep.
 *
 * Imported by the custom worker entry (worker/index.ts) for the cron sweep,
 * so this module and its import chain use relative/package imports only —
 * no `$lib`, no `@sveltejs/kit` (same constraint as schedule-sweep.ts).
 */
import {
	ACTIVE_RUN_STATUSES,
	LAUNCH_STALL_MS,
	RUN_KEY_SLACK_MS,
	RUNNER_OFFLINE_FAIL_MS,
	type ModelTier,
	type QuotaPolicy,
	type RoutingTarget,
	type RunEndOutcome,
	type RunnerBudget
} from '@tines/shared';
import type { D1Result } from '@cloudflare/workers-types';
import { sql, type CompiledQuery, type Kysely, type RawBuilder } from 'kysely';
import { sha256Hex } from '../crypto';
import { getDb, newId, randomString, type Database } from '../db';
import { buildAdapters, type AdapterRegistry, type RunnerAdapter } from './adapter';
import {
	appendLogTail,
	launchBackoffMs,
	rateLimitHoldUntil,
	resolveRoute,
	resolveEffort,
	resolveTier,
	targetVerdict,
	type ActiveCounts,
	type MatchableRule
} from './logic';
import {
	disposeExpiredResumeResources,
	orderTargetsByResumeAffinity,
	resumeAffinityByIssue
} from './resume';
import { loadSealableRun, sealRunLog, spillEvicted, sweepRunLogs } from './run-log';
import { effectiveAutomationEnabled } from './settings';
import { mergeEffortEvidence, type EffortMilestone } from './effort-evidence';

const ACTIVE = [...ACTIVE_RUN_STATUSES];

export interface DispatchPassOptions {
	now?: number;
	adapters?: AdapterRegistry;
}

// ---------------------------------------------------------------------------
// Small local plumbing (core.ts is off-limits here: it imports @sveltejs/kit)

async function runBatch(env: Env, queries: CompiledQuery[]): Promise<D1Result[]> {
	if (queries.length === 0) return [];
	return env.DB.batch(
		queries.map((q) => env.DB.prepare(q.sql).bind(...(q.parameters as unknown[])))
	);
}

/**
 * Supervisor-initiated event: attributed to the owning user with no API key
 * (the schedules-sweep pattern); the run is identified in the payload. An
 * optional guard ties the insert to another statement in the same batch.
 * Also used by the runner protocol for daemon-initiated changes (no
 * ActorContext exists there either).
 */
export function supervisorEvent(
	db: Kysely<Database>,
	userId: string,
	input: {
		type: string;
		issueId?: string | null;
		projectId?: string | null;
		payload: Record<string, unknown>;
	},
	now: number,
	guard?: RawBuilder<boolean>
): CompiledQuery {
	const projectId = input.issueId
		? sql`(SELECT project_id FROM issue WHERE id = ${input.issueId})`
		: sql`${input.projectId ?? null}`;
	return sql`
		INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
		SELECT ${newId('evt')}, ${userId}, ${input.type}, ${userId}, ${null},
			${input.issueId ?? null}, ${projectId}, ${JSON.stringify(input.payload)}, ${now}
		WHERE ${guard ?? sql`1`}`.compile(db);
}

// ---------------------------------------------------------------------------
// Loading

export interface DispatchSettings {
	enabled: boolean;
	quota: QuotaPolicy;
	attemptLimit: number;
}

const DEFAULT_QUOTA: QuotaPolicy = { type: 'global_cap', limit: 3 };

export async function loadDispatchSettings(
	db: Kysely<Database>,
	userId: string
): Promise<DispatchSettings> {
	const row = await db
		.selectFrom('supervisor_settings')
		.select(['enabled', 'quota', 'attempt_limit'])
		.where('user_id', '=', userId)
		.executeTakeFirst();
	if (!row) {
		return {
			enabled: effectiveAutomationEnabled(undefined),
			quota: DEFAULT_QUOTA,
			attemptLimit: 3
		};
	}
	let quota = DEFAULT_QUOTA;
	try {
		quota = JSON.parse(row.quota) as QuotaPolicy;
	} catch {
		// Unreadable policy column falls back to the default.
	}
	return {
		enabled: effectiveAutomationEnabled(row.enabled),
		quota,
		attemptLimit: row.attempt_limit
	};
}

export interface CandidateIssue {
	id: string;
	project_id: string;
	state_id: string;
	updated_at: number;
	pinned_runner_id: string | null;
	pinned_tier: string | null;
	/** Internal ABA fence captured with routing selection. */
	project_assignment_token?: string;
	/** Labels the issue carries, for label-scoped rule matching. */
	label_ids: string[];
}

/**
 * A candidate plus the columns only the fleet queue's display needs. Carried
 * on the same query rather than a second refs round trip; `CandidateIssue`
 * itself is unchanged, so the pass and the explainer are untouched.
 */
export interface EligibleIssue extends CandidateIssue {
	number: number;
	title: string;
	project_name: string;
	state_name: string;
	workflow_id: string;
	workflow_name: string;
	/** `state_entered_at ?? created_at` — time in the current state. */
	entered_at: number;
}

/** The row shape the candidate query returns: `label_ids` arrives as JSON. */
type CandidateRow = Omit<EligibleIssue, 'label_ids' | 'entered_at'> & {
	label_ids_json: string | null;
	created_at: number;
	state_entered_at: number | null;
};

/**
 * Dispatchable issues, oldest-`updated_at` first: effective state category
 * `active`, ready per the dependencies logic (not a duplicate, no blocker
 * still effectively open), not parked, no active run. Rule/pin matching and
 * the kill switch are the caller's checks. Blockers resolve duplicate chains
 * the same way issues.ts does (bounded recursion; cycles degrade safely).
 */
export async function loadEligibleIssues(
	db: Kysely<Database>,
	userId: string
): Promise<EligibleIssue[]> {
	const result = await sql<CandidateRow>`
		WITH RECURSIVE dup_chain(issue_id, next_id, depth) AS (
			SELECT source_issue_id, target_issue_id, 1 FROM issue_link WHERE kind = 'duplicate_of'
			UNION ALL
			SELECT dc.issue_id, il.target_issue_id, dc.depth + 1
			FROM dup_chain dc
			JOIN issue_link il ON il.source_issue_id = dc.next_id AND il.kind = 'duplicate_of'
			WHERE dc.depth < 32
		),
		effective(issue_id, effective_issue_id) AS (
			SELECT issue_id, next_id FROM dup_chain
			WHERE NOT EXISTS (
				SELECT 1 FROM issue_link WHERE source_issue_id = dup_chain.next_id AND kind = 'duplicate_of'
			)
		)
		SELECT issue.id, issue.project_id, issue.state_id, issue.updated_at,
			issue.project_assignment_token,
			issue.pinned_runner_id, issue.pinned_tier,
			-- Display columns for the fleet queue's refs and grouping. Free
			-- here: the joins they read are already in the FROM clause.
			issue.number, issue.title, issue.created_at, issue.state_entered_at,
			project.name AS project_name, st.name AS state_name,
			wf.id AS workflow_id, wf.name AS workflow_name,
			-- Aggregated in the same statement rather than a second round
			-- trip: rule matching needs every candidate's labels anyway.
			(SELECT json_group_array(il.label_id) FROM issue_label il
				WHERE il.issue_id = issue.id) AS label_ids_json
		FROM issue
		JOIN project ON project.id = issue.project_id
		JOIN workflow_state st ON st.id = issue.state_id
		JOIN workflow wf ON wf.id = issue.workflow_id
		WHERE project.user_id = ${userId}
			AND project.archived_at IS NULL
			AND st.category = 'active'
			AND issue.needs_attention = 0
			AND NOT EXISTS (
				SELECT 1 FROM issue_link dl WHERE dl.source_issue_id = issue.id AND dl.kind = 'duplicate_of'
			)
			AND NOT EXISTS (
				SELECT 1 FROM issue_link bl
				JOIN issue bi ON bi.id = bl.source_issue_id
				LEFT JOIN effective be ON be.issue_id = bi.id
				LEFT JOIN issue bei ON bei.id = be.effective_issue_id
				JOIN workflow_state bs ON bs.id = COALESCE(bei.state_id, bi.state_id)
				WHERE bl.target_issue_id = issue.id AND bl.kind = 'blocks' AND bs.category != 'done'
			)
			AND NOT EXISTS (
				SELECT 1 FROM agent_run
				WHERE issue_id = issue.id AND status IN (${sql.join(ACTIVE)})
			)
		ORDER BY issue.updated_at ASC, issue.id ASC`.execute(db);
	return result.rows.map(({ label_ids_json, created_at, state_entered_at, ...row }) => {
		// A malformed aggregate degrades to "carries no labels" — the issue
		// then matches only unlabelled rules rather than failing the pass.
		let label_ids: string[] = [];
		try {
			const parsed = JSON.parse(label_ids_json ?? '[]');
			if (Array.isArray(parsed)) label_ids = parsed.filter((v) => typeof v === 'string');
		} catch {
			// keep the empty list
		}
		// `state_entered_at` is nullable (migration 0011 backfilled it, but
		// nothing enforces it), so the wait clock falls back to creation.
		return { ...row, label_ids, entered_at: state_entered_at ?? created_at };
	});
}

export async function loadActiveCounts(
	db: Kysely<Database>,
	userId: string
): Promise<ActiveCounts> {
	const rows = await db
		.selectFrom('agent_run')
		.select(['runner_id', 'state_id_at_start'])
		.select((eb) => eb.fn.countAll<number>().as('n'))
		.where('user_id', '=', userId)
		.where('status', 'in', ACTIVE)
		.groupBy(['runner_id', 'state_id_at_start'])
		.execute();
	const counts: ActiveCounts = { total: 0, byRunner: new Map(), byStartState: new Map() };
	for (const row of rows) {
		const n = Number(row.n);
		counts.total += n;
		counts.byRunner.set(row.runner_id, (counts.byRunner.get(row.runner_id) ?? 0) + n);
		counts.byStartState.set(
			row.state_id_at_start,
			(counts.byStartState.get(row.state_id_at_start) ?? 0) + n
		);
	}
	return counts;
}

export type EngineRunner = Database['runner'];

export async function loadEngineRunners(
	db: Kysely<Database>,
	userId: string
): Promise<Map<string, EngineRunner>> {
	const rows = await db.selectFrom('runner').selectAll().where('user_id', '=', userId).execute();
	return new Map(rows.map((r) => [r.id, r]));
}

export type EngineRule = MatchableRule;

export async function loadEngineRules(db: Kysely<Database>, userId: string): Promise<EngineRule[]> {
	const rows = await db
		.selectFrom('routing_rule')
		.select(['id', 'project_id', 'workflow_state_id', 'label_id', 'targets'])
		.where('user_id', '=', userId)
		.execute();
	return rows.map((r) => {
		let targets: RoutingTarget[] = [];
		try {
			targets = JSON.parse(r.targets) as RoutingTarget[];
		} catch {
			// An unreadable target list dispatches nothing rather than crashing.
		}
		return {
			id: r.id,
			project_id: r.project_id,
			workflow_state_id: r.workflow_state_id,
			label_id: r.label_id,
			targets
		};
	});
}

/** The targets to walk for an issue: the pin replaces rule matching entirely. */
export function targetsForIssue(
	issue: CandidateIssue,
	rules: EngineRule[]
): ReturnType<typeof resolveRoute<EngineRule>> & { pinned: boolean } {
	if (issue.pinned_runner_id) {
		return {
			targets: [
				{ runner_id: issue.pinned_runner_id, tier: (issue.pinned_tier as ModelTier | null) ?? null }
			],
			rule: null,
			ambiguous: [],
			runnerRule: null,
			tierOverride: null,
			effortOverride: null,
			effortRule: null,
			failure: null,
			pinned: true
		};
	}
	// An ambiguous match yields no targets, so the pass skips the issue
	// exactly as it does one with no matching rule at all — no strike, no run.
	const resolved = resolveRoute(
		{ project_id: issue.project_id, state_id: issue.state_id, label_ids: issue.label_ids },
		rules
	);
	return { ...resolved, pinned: false };
}

// ---------------------------------------------------------------------------
// The guarded claim: one self-guarding INSERT … SELECT per attempt

/**
 * Claims an issue for a runner. The WHERE re-checks, inside the statement:
 * the issue is still eligible (state unchanged and category `active`, not
 * parked, no active run), the runner is under `max_concurrent`, and the
 * active quota policy's count is under its limit — the three aggregate
 * guards D1's single-row CAS idiom cannot carry. Zero rows inserted = a
 * concurrent pass won the race; never an error. `state_id_at_start` is the
 * issue's state read inside the same statement (`= stateId` pins it to the
 * state the pass routed for, so routing and roster counting agree).
 */
export async function claimRun(
	db: Kysely<Database>,
	env: Env,
	input: {
		runId: string;
		userId: string;
		issueId: string;
		/** Project captured with routing selection; fences a stale source route. */
		projectId: string;
		stateId: string;
		runnerId: string;
		maxConcurrent: number;
		tier: ModelTier;
		model: string | null;
		requestedEffort?: string | null;
		resolvedEffort?: string | null;
		effortSource?: import('@tines/shared').EffortSource;
		effortDeliveryMode?: import('./logic').EffortDeliveryMode;
		quota: QuotaPolicy;
		now: number;
		/** Token captured by candidate selection; omitted only by pre-transfer tests/callers. */
		projectAssignmentToken?: string;
	}
): Promise<boolean> {
	const assignmentToken = input.projectAssignmentToken ?? '';
	const quotaGuard =
		input.quota.type === 'global_cap'
			? sql<boolean>`(
					SELECT COUNT(*) FROM agent_run
					WHERE user_id = ${input.userId} AND status IN (${sql.join(ACTIVE)})
				) < ${input.quota.limit}`
			: sql<boolean>`(
					SELECT COUNT(*) FROM agent_run
					WHERE user_id = ${input.userId} AND state_id_at_start = ${input.stateId}
						AND status IN (${sql.join(ACTIVE)})
				) < ${input.quota.overrides[input.stateId] ?? input.quota.default_limit}`;

	const claim = sql`
		INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, tier, model,
			requested_effort, resolved_effort, effort_source, effort_application_status,
			state_id_at_start, log, log_bytes_dropped, created_at, project_assignment_token)
		SELECT ${input.runId}, ${input.userId}, issue.id, ${input.runnerId}, 'assigned',
			${input.tier}, ${input.model}, ${input.requestedEffort ?? null}, ${input.resolvedEffort ?? null},
			${input.effortSource ? JSON.stringify(input.effortSource) : null}, ${input.effortDeliveryMode === 'legacy_tier' ? 'legacy_not_applied' : input.resolvedEffort ? 'pending' : 'not_requested'},
			issue.state_id, '', 0, ${input.now}, ${assignmentToken}
		FROM issue
		JOIN project ON project.id = issue.project_id
		JOIN workflow_state st ON st.id = issue.state_id
		WHERE issue.id = ${input.issueId}
			AND issue.project_id = ${input.projectId}
			AND issue.state_id = ${input.stateId}
			AND issue.project_assignment_token = ${assignmentToken}
			-- Race guard: the project may have been archived between the pass
			-- reading the queue and this claim.
			AND project.archived_at IS NULL
			AND st.category = 'active'
			AND issue.needs_attention = 0
			AND NOT EXISTS (
				SELECT 1 FROM agent_run
				WHERE issue_id = issue.id AND status IN (${sql.join(ACTIVE)})
			)
			AND (
				SELECT COUNT(*) FROM agent_run
				WHERE runner_id = ${input.runnerId} AND status IN (${sql.join(ACTIVE)})
			) < ${input.maxConcurrent}
			AND ${quotaGuard}`.compile(db);
	const [result] = await runBatch(env, [claim]);
	return (result?.meta.changes ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// Launching (immediate-mode adapters; local runs wait for poll delivery)

/**
 * 'launched': the run reached `running`. 'launch_failed': the adapter threw
 * (backoff applied; the pass tries the next target). 'lost': the run was
 * ended (canceled, swept) between the claim and the launching flip — the
 * pass stands down on this issue.
 */
type LaunchOutcome = 'launched' | 'launch_failed' | 'lost';

/**
 * The one-shot delivery flip: mints the run key and flips the claim
 * `assigned → launching` in one guarded batch. Null = the run was ended (or
 * already delivered) between the claim and this flip — the key minted
 * alongside is revoked here, and the caller stands down. Shared by
 * immediate-mode launches (below) and poll-delivery (the runner protocol),
 * so a run is delivered exactly once even across racing polls.
 */
export async function mintRunKeyAndFlip(
	db: Kysely<Database>,
	env: Env,
	input: {
		runId: string;
		userId: string;
		maxRunMinutes: number;
		now: number;
		localAdmission?: { runnerId: string; instanceId: string; ceiling: number };
	}
): Promise<{ keyId: string; secret: string } | null> {
	const secret = `tines_${randomString(40)}`;
	const keyId = newId('key');
	const [, flip] = await runBatch(env, [
		db
			.insertInto('api_key')
			.values({
				id: keyId,
				user_id: input.userId,
				name: `run ${input.runId}`,
				key_hash: await sha256Hex(secret),
				key_prefix: secret.slice(0, 14),
				agent_run_id: input.runId,
				expires_at: input.now + input.maxRunMinutes * 60_000 + RUN_KEY_SLACK_MS,
				created_at: input.now,
				last_used_at: null,
				revoked_at: null
			})
			.compile(),
		db
			.updateTable('agent_run')
			.set({ status: 'launching', api_key_id: keyId })
			.where('id', '=', input.runId)
			.where('status', '=', 'assigned')
			.$if(input.localAdmission !== undefined, (query) => {
				const admission = input.localAdmission!;
				return query.where(sql<boolean>`EXISTS (
					SELECT 1 FROM runner
					WHERE id = ${admission.runnerId} AND user_id = ${input.userId}
						AND daemon_instance_id = ${admission.instanceId}
						AND concurrency_instance_id = ${admission.instanceId}
						AND concurrency_ceiling = ${admission.ceiling}
						AND (
							SELECT COUNT(*) FROM agent_run
							WHERE runner_id = ${admission.runnerId} AND status IN ('launching', 'running')
						) < ${admission.ceiling}
				)`);
			})
			.compile()
	]);
	if ((flip?.meta.changes ?? 0) === 0) {
		// The run was ended (canceled or swept) between the claim and this
		// flip. The key minted alongside it post-dates endRun's revocation
		// sweep, so it must die here — and no provider session is created.
		await runBatch(env, [
			db.updateTable('api_key').set({ revoked_at: input.now }).where('id', '=', keyId).compile()
		]);
		return null;
	}
	return { keyId, secret };
}

/**
 * Atomically settles assignments a daemon refused before launch. The status
 * guard and key revocation share one receipt, so a first log that wins the
 * race preserves the running process and its credential.
 */
export async function releaseDeclinedAssignments(
	db: Kysely<Database>,
	env: Env,
	input: { userId: string; runnerId: string; runIds: string[]; now: number },
	onReleased: () => void
): Promise<string[]> {
	const released: string[] = [];
	for (const runId of input.runIds) {
		const run = await db
			.selectFrom('agent_run')
			.select(['id', 'issue_id', 'status', 'started_at'])
			.where('id', '=', runId)
			.where('user_id', '=', input.userId)
			.where('runner_id', '=', input.runnerId)
			.executeTakeFirst();
		if (!run || !ACTIVE.includes(run.status as (typeof ACTIVE)[number])) {
			released.push(runId);
			continue;
		}
		if (run.status !== 'launching' || run.started_at !== null) continue;
		const receipt = newId('evt');
		const guard = sql<boolean>`EXISTS (
			SELECT 1 FROM agent_run
			WHERE id = ${runId} AND user_id = ${input.userId} AND runner_id = ${input.runnerId}
				AND status = 'launching' AND started_at IS NULL
		)`;
		const [eventResult, updateResult] = await runBatch(env, [
			sql`
				INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
				SELECT ${receipt}, ${input.userId}, 'agent_run.ended', ${input.userId}, NULL,
					${run.issue_id}, (SELECT project_id FROM issue WHERE id = ${run.issue_id}),
					${JSON.stringify({ run_id: runId, status: 'canceled', error: 'launch refused by local concurrency ceiling' })},
					${input.now}
				WHERE ${guard}`.compile(db),
			db
				.updateTable('agent_run')
				.set({
					status: 'canceled',
					ended_at: input.now,
					error: 'launch refused by local concurrency ceiling',
					outcome: null
				})
				.where('id', '=', runId)
				.where(sql<boolean>`EXISTS (SELECT 1 FROM event WHERE id = ${receipt})`)
				.compile(),
			db
				.updateTable('api_key')
				.set({ revoked_at: input.now })
				.where('agent_run_id', '=', runId)
				.where(sql<boolean>`EXISTS (SELECT 1 FROM event WHERE id = ${receipt})`)
				.compile()
		]);
		if ((eventResult?.meta.changes ?? 0) === 1 && (updateResult?.meta.changes ?? 0) === 1) {
			released.push(runId);
			onReleased();
		}
	}
	return released;
}

/**
 * Mints the run key, flips the claim to `launching`, calls the adapter, and
 * records the outcome. A thrown launch is a launch failure — error on the
 * run, exponential backoff and a `runner.errored` event on the *runner*,
 * never a strike on the issue.
 */
export async function launchClaimedRun(
	db: Kysely<Database>,
	env: Env,
	adapter: RunnerAdapter,
	ctx: {
		userId: string;
		runId: string;
		issueId: string;
		projectId: string;
		runner: EngineRunner;
		tier: ModelTier;
		model: string | null;
		effort?: string | null;
		now: number;
	}
): Promise<LaunchOutcome> {
	const { runner } = ctx;
	const minted = await mintRunKeyAndFlip(db, env, {
		runId: ctx.runId,
		userId: ctx.userId,
		maxRunMinutes: runner.max_run_minutes,
		now: ctx.now
	});
	if (!minted) return 'lost';
	const { secret } = minted;

	try {
		const launched = await adapter.launch({
			runId: ctx.runId,
			issueId: ctx.issueId,
			runner: {
				id: runner.id,
				type: runner.type,
				name: runner.name,
				config: runner.config,
				max_run_minutes: runner.max_run_minutes
			},
			tier: ctx.tier,
			model: ctx.model,
			effort: ctx.effort,
			recordEffortEvidence: ctx.effort
				? async (evidence) => {
						for (let attempt = 0; attempt < 3; attempt++) {
							const current = await db
								.selectFrom('agent_run')
								.select(['status', 'effort_application_status', 'effort_application_evidence'])
								.where('id', '=', ctx.runId)
								.executeTakeFirst();
							if (!current || !(ACTIVE_RUN_STATUSES as readonly string[]).includes(current.status))
								return;
							const merged = mergeEffortEvidence(
								(current.effort_application_status ??
									'unknown') as import('@tines/shared').EffortApplicationStatus,
								current.effort_application_evidence,
								evidence as EffortMilestone,
								Date.now()
							);
							let update = db
								.updateTable('agent_run')
								.set({
									effort_application_status: merged.status,
									effort_application_evidence: merged.evidence
								})
								.where('id', '=', ctx.runId)
								.where('status', 'in', [...ACTIVE_RUN_STATUSES]);
							update = current.effort_application_status
								? update.where('effort_application_status', '=', current.effort_application_status)
								: update.where('effort_application_status', 'is', null);
							update = current.effort_application_evidence
								? update.where(
										'effort_application_evidence',
										'=',
										current.effort_application_evidence
									)
								: update.where('effort_application_evidence', 'is', null);
							const result = await update.executeTakeFirst();
							if (Number(result.numUpdatedRows) === 1) return;
						}
						throw new Error('effort evidence changed repeatedly during managed launch');
					}
				: undefined,
			runKey: secret
		});
		const startedAt = ctx.now;
		// Guard the event on the flip landing: a run canceled mid-launch must
		// not record a start. (Its provider session becomes an orphan for
		// launch reconciliation; nothing to do here.)
		const startedGuard = sql<boolean>`EXISTS (
			SELECT 1 FROM agent_run WHERE id = ${ctx.runId} AND status = 'running' AND started_at = ${startedAt}
		)`;
		await runBatch(env, [
			db
				.updateTable('agent_run')
				.set({
					status: 'running',
					started_at: startedAt,
					provider_session_id: launched.provider_session_id ?? null,
					provider_url: launched.provider_url ?? null,
					provider_meta: launched.provider_meta ?? null
				})
				.where('id', '=', ctx.runId)
				.where('status', '=', 'launching')
				.compile(),
			// A successful launch clears the failure count and any hold — a
			// usage-limit hold included: the provider just took the work.
			db
				.updateTable('runner')
				.set({ launch_failures: 0, backoff_until: null, backoff_reason: null })
				.where('id', '=', runner.id)
				.where((eb) => eb.or([eb('launch_failures', '>', 0), eb('backoff_until', 'is not', null)]))
				.compile(),
			supervisorEvent(
				db,
				ctx.userId,
				{
					type: 'agent_run.started',
					issueId: ctx.issueId,
					projectId: ctx.projectId,
					payload: {
						run_id: ctx.runId,
						runner_id: runner.id,
						runner_name: runner.name,
						tier: ctx.tier,
						model: ctx.model
					}
				},
				startedAt,
				startedGuard
			)
		]);
		return 'launched';
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		await failLaunch(db, env, {
			userId: ctx.userId,
			runId: ctx.runId,
			runner,
			error: message,
			now: ctx.now
		});
		return 'launch_failed';
	}
}

/**
 * The launch-failure treatment, shared by in-pass failures and the sweep's
 * stalled-launch reconciliation: error recorded on the run, key revoked,
 * runner backed off (2× per consecutive failure, max 1 h) and flagged.
 */
async function failLaunch(
	db: Kysely<Database>,
	env: Env,
	input: { userId: string; runId: string; runner: EngineRunner; error: string; now: number }
): Promise<void> {
	const failures = input.runner.launch_failures + 1;
	await runBatch(env, [
		db
			.updateTable('agent_run')
			.set({ status: 'failed', error: input.error, ended_at: input.now })
			.where('id', '=', input.runId)
			.where('status', 'in', ['assigned', 'launching'])
			.compile(),
		db
			.updateTable('api_key')
			.set({ revoked_at: input.now })
			.where('agent_run_id', '=', input.runId)
			.where('revoked_at', 'is', null)
			.compile(),
		db
			.updateTable('runner')
			.set({
				launch_failures: sql<number>`launch_failures + 1`,
				backoff_until: input.now + launchBackoffMs(failures),
				// This hold is the failure backoff, whatever the last one was.
				backoff_reason: null
			})
			.where('id', '=', input.runner.id)
			.compile(),
		supervisorEvent(
			db,
			input.userId,
			{
				type: 'runner.errored',
				payload: {
					runner_id: input.runner.id,
					runner_name: input.runner.name,
					run_id: input.runId,
					error: input.error,
					consecutive_failures: failures
				}
			},
			input.now
		)
	]);
}

/**
 * Runner-health pressure for a pipe failure *after* launch: the same
 * counter, backoff and `runner.errored` event `failLaunch` applies, minus
 * everything about the run (an interrupted run is ended by `endRun`, which
 * already flipped it and revoked its key).
 *
 * It exists because removing the strike removes the only bound there was on
 * a crash-looping daemon: with no per-runner budget enforcement yet, the
 * backoff is what stops a runner that dies every time from re-taking the
 * same issue forever. The issue is no longer blamed, but the loop is still
 * broken — the guard rail moved from the strike system to runner health.
 *
 * Counted once per *incident*, not per run: one offline sweep pass ends
 * every run of a runner, and one shutdown finish-reports all of them. The
 * backoff window is the incident marker — both statements are guarded on it
 * being absent or expired, so the first end of a burst trips the backoff and
 * the rest fall inside it and no-op. Reusing the window costs no new column
 * and keeps a genuinely flapping runner escalating (2× per consecutive
 * failure), which is exactly the behaviour launch failures already get.
 *
 * Cleared only by a successful launch, as launch failures are. Deliberately
 * *not* by a poll: a returning daemon polls within 15 seconds, which would
 * erase the backoff in precisely the case it exists for.
 */
export async function noteInterruption(
	db: Kysely<Database>,
	env: Env,
	input: { userId: string; runnerId: string; runId?: string; error: string; now: number }
): Promise<void> {
	const runner = await db
		.selectFrom('runner')
		.select(['id', 'name', 'launch_failures', 'backoff_until'])
		.where('id', '=', input.runnerId)
		.executeTakeFirst();
	if (!runner) return;
	// The read-to-write race here is harmless: a concurrent increment implies
	// a live backoff window, which the guard below then rejects.
	if (runner.backoff_until !== null && runner.backoff_until >= input.now) return;
	const failures = runner.launch_failures + 1;
	const fresh = sql<boolean>`EXISTS (
		SELECT 1 FROM runner
		WHERE id = ${runner.id} AND (backoff_until IS NULL OR backoff_until < ${input.now})
	)`;
	await runBatch(env, [
		// The event first: it reads the pre-update state through the same
		// guard, so it lands iff the increment below does.
		supervisorEvent(
			db,
			input.userId,
			{
				type: 'runner.errored',
				payload: {
					runner_id: runner.id,
					runner_name: runner.name,
					...(input.runId ? { run_id: input.runId } : {}),
					error: input.error,
					consecutive_failures: failures
				}
			},
			input.now,
			fresh
		),
		sql`
			UPDATE runner SET launch_failures = launch_failures + 1,
				backoff_until = ${input.now + launchBackoffMs(failures)},
				backoff_reason = NULL
			WHERE id = ${runner.id} AND (backoff_until IS NULL OR backoff_until < ${input.now})`.compile(db)
	]);
}

/**
 * The runner's harness reported a provider usage limit: hold it until the
 * window resets and say so, without touching `launch_failures`.
 *
 * Deliberately not `noteInterruption`: the reset time is *known*, so guessing
 * an exponential window would keep probing a wall that will not move for
 * hours, and a busy afternoon would read as the dead-credential escalation
 * the failure counter exists to raise. Deliberately not `status = 'paused'`
 * either — a pause needs a human to undo, which is the toil this removes.
 *
 * The guard collapses a burst (three long runs die within seconds of each
 * other) into one hold and one event, but — unlike the interruption guard —
 * a *later* reset still extends a live hold: better information wins.
 */
export async function noteRateLimit(
	db: Kysely<Database>,
	env: Env,
	input: {
		userId: string;
		runnerId: string;
		runId?: string;
		error: string;
		/** What the provider said, epoch ms; null when it said nothing usable. */
		resumeAt: number | null;
		/** Which window (`five_hour`, `seven_day`, …) when the harness named one. */
		limit: string | null;
		now: number;
	}
): Promise<void> {
	const runner = await db
		.selectFrom('runner')
		.select(['id', 'name', 'backoff_until', 'backoff_reason'])
		.where('id', '=', input.runnerId)
		.executeTakeFirst();
	if (!runner) return;
	const until = rateLimitHoldUntil(input.resumeAt, input.now);
	// Already held at least this long for the same reason: nothing to say.
	if (
		runner.backoff_reason === 'rate_limit' &&
		runner.backoff_until !== null &&
		runner.backoff_until >= until
	)
		return;
	const fresh = sql<boolean>`EXISTS (
		SELECT 1 FROM runner
		WHERE id = ${runner.id}
			AND (backoff_reason IS NOT 'rate_limit' OR backoff_until IS NULL OR backoff_until < ${until})
	)`;
	await runBatch(env, [
		supervisorEvent(
			db,
			input.userId,
			{
				type: 'runner.rate_limited',
				payload: {
					runner_id: runner.id,
					runner_name: runner.name,
					...(input.runId ? { run_id: input.runId } : {}),
					error: input.error,
					resets_at: until,
					reported_reset_at: input.resumeAt,
					limit: input.limit
				}
			},
			input.now,
			fresh
		),
		// A known reset beats a live failure backoff's guess, so this
		// overwrites one; `launch_failures` is left for a successful launch.
		sql`
			UPDATE runner SET backoff_until = ${until}, backoff_reason = 'rate_limit'
			WHERE id = ${runner.id}
				AND (backoff_reason IS NOT 'rate_limit' OR backoff_until IS NULL OR backoff_until < ${until})`.compile(
			db
		)
	]);
}

// ---------------------------------------------------------------------------
// The dispatch pass

export interface DispatchPassResult {
	/** Claims that landed (assigned or beyond). */
	claimed: number;
	/** Claims that reached `running` in this pass (immediate adapters). */
	launched: number;
}

/**
 * One dispatch pass for one user: walk eligible issues oldest-`updated_at`
 * first, resolve pin/rule targets in order, and claim + launch. Claims are
 * sequential so earlier claims count against later guards; the in-memory
 * verdicts are selection only — the guarded INSERT is the authority.
 */
export async function runDispatchPass(
	db: Kysely<Database>,
	env: Env,
	userId: string,
	opts: DispatchPassOptions = {}
): Promise<DispatchPassResult> {
	const adapters = opts.adapters ?? buildAdapters(env);
	const now = opts.now ?? Date.now();
	const result: DispatchPassResult = { claimed: 0, launched: 0 };

	const settings = await loadDispatchSettings(db, userId);
	if (!settings.enabled) return result;

	const [candidates, runners, rules, counts] = await Promise.all([
		loadEligibleIssues(db, userId),
		loadEngineRunners(db, userId),
		loadEngineRules(db, userId),
		loadActiveCounts(db, userId)
	]);
	if (candidates.length === 0) return result;

	// Runner affinity for resume: which runners hold a live retained session
	// for these issues. Used only to reorder targets routing already chose.
	const affinity = await resumeAffinityByIssue(
		db,
		userId,
		candidates.map((issue) => issue.id),
		now
	).catch(() => new Map<string, Set<string>>());

	for (const issue of candidates) {
		// With the global cap saturated nothing more can dispatch this pass.
		if (settings.quota.type === 'global_cap' && counts.total >= settings.quota.limit) break;
		const route = targetsForIssue(issue, rules);
		const { targets } = route;
		for (const target of orderTargetsByResumeAffinity(targets, affinity.get(issue.id))) {
			const runner = runners.get(target.runner_id);
			if (!runner) continue; // stale target (runner removed mid-pass)
			const adapter = adapters[runner.type];
			if (!adapter) continue;
			const { verdict } = targetVerdict(runner, counts, settings.quota, issue.state_id, now);
			if (verdict !== 'ok') continue;

			const resolved = resolveTier(runner, target.tier ?? null);
			const requestedEffort = target.effort ?? null;
			const effort = resolveEffort(runner, resolved, requestedEffort);
			if (!effort.compatible) continue;
			const resolvedEffort = effort.resolved;
			const effortSource: import('@tines/shared').EffortSource = requestedEffort
				? {
						kind: 'routing_target',
						runner_id: runner.id,
						tier: resolved.tier,
						rule_id: route.effortRule?.id ?? route.runnerRule?.id ?? route.rule?.id ?? '',
						scope_label: `rule ${route.effortRule?.id ?? route.runnerRule?.id ?? route.rule?.id ?? 'unknown'}`,
						target_index: targets.findIndex((candidate) => candidate === target)
					}
				: resolvedEffort
					? { kind: 'runner_tier', runner_id: runner.id, tier: resolved.tier }
					: { kind: 'none', runner_id: runner.id, tier: resolved.tier };
			const runId = newId('arun');
			const claimed = await claimRun(db, env, {
				runId,
				userId,
				issueId: issue.id,
				projectId: issue.project_id,
				stateId: issue.state_id,
				runnerId: runner.id,
				maxConcurrent: runner.max_concurrent,
				tier: resolved.tier,
				model: resolved.model,
				requestedEffort,
				resolvedEffort,
				effortSource,
				effortDeliveryMode: effort.deliveryMode,
				quota: settings.quota,
				now,
				projectAssignmentToken: issue.project_assignment_token
			});
			// A lost race means something changed under us (another pass claimed
			// the issue, or capacity vanished); leave this issue to the next pass.
			if (!claimed) break;
			result.claimed += 1;
			counts.total += 1;
			counts.byRunner.set(runner.id, (counts.byRunner.get(runner.id) ?? 0) + 1);
			counts.byStartState.set(issue.state_id, (counts.byStartState.get(issue.state_id) ?? 0) + 1);

			// Local runs stay `assigned` for poll delivery; the claim is done.
			if (adapter.launchMode === 'poll') break;

			const launched = await launchClaimedRun(db, env, adapter, {
				userId,
				runId,
				issueId: issue.id,
				projectId: issue.project_id,
				runner,
				tier: resolved.tier,
				model: resolved.model,
				effort: effort.deliveryMode === 'enforce' ? resolvedEffort : null,
				now
			});
			if (launched === 'launched') {
				result.launched += 1;
				break;
			}
			// Either way the claim is released (the run is terminal): undo the
			// counts this pass tracked for it.
			result.claimed -= 1;
			counts.total -= 1;
			counts.byRunner.set(runner.id, (counts.byRunner.get(runner.id) ?? 0) - 1);
			counts.byStartState.set(issue.state_id, (counts.byStartState.get(issue.state_id) ?? 0) - 1);
			// Someone ended the run mid-launch (cancel, sweep): their call —
			// leave the issue alone this pass.
			if (launched === 'lost') break;
			// Launch failure: try the next runner in the preference list — the
			// issue didn't fail, the pipe did.
			runner.launch_failures += 1;
			runner.backoff_until = now + launchBackoffMs(runner.launch_failures);
			runner.backoff_reason = null;
		}
	}
	return result;
}

/**
 * Schedules the centralized request collector's opportunistic pass on
 * waitUntil. Setup and pass failures are best-effort; the periodic sweep is
 * the reliability guarantee.
 */
export function queueDispatchPass(
	platform: { env: Env; ctx?: { waitUntil(promise: Promise<unknown>): void } } | undefined,
	userId: string
): void {
	if (!platform) return;
	const pass = runDispatchPass(getDb(platform.env), platform.env, userId).catch((e) => {
		console.error('opportunistic dispatch pass failed:', e);
	});
	platform.ctx?.waitUntil?.(pass);
}

// ---------------------------------------------------------------------------
// End judgment: strikes, parking, key revocation

export interface EndRunOutcome {
	/** False when another pass already ended the run (lost the CAS). */
	ended: boolean;
	/** Null for runs that never started (nothing to judge). */
	outcome: RunEndOutcome | null;
	parked: boolean;
}

interface EndableRun {
	id: string;
	user_id: string;
	issue_id: string;
	runner_id: string;
	status: string;
	api_key_id: string | null;
	started_at: number | null;
	state_id_at_start: string;
	provider_session_id: string | null;
	usage: string | null;
}

/**
 * Ends a run and judges it: did an `issue.transitioned` event authored by
 * this run's key occur during the run? Yes = advanced (attempt count resets);
 * no — completed, failed, timed out, or canceled alike — a strike, parking
 * the issue at the attempt limit. Runs that never reached `running` (a
 * canceled `assigned` run, e.g.) are not judged: nothing happened yet.
 *
 * `judgment: 'interrupted'` is the exception the caller asks for when the
 * *pipe* died rather than the work — the offline sweep, `owned_runs` loss, a
 * daemon reporting its own shutdown or orphans. Such a run is still `failed`,
 * but the issue is charged nothing (no strike, and no reset either); the
 * pressure goes on the runner instead, via `noteInterruption`.
 *
 * The status flip runs first, alone, as the CAS: whoever lands it owns the
 * end, and a losing caller (concurrent sweep vs. cancel — possibly with an
 * identical clock) returns before writing anything else. The dependent
 * writes keep the flip guard as belt-and-braces, and the strike increments
 * `attempt_count` inside the statement so a manual reset racing this end is
 * never overwritten with a stale count.
 */
export async function endRun(
	db: Kysely<Database>,
	env: Env,
	run: EndableRun,
	input: {
		status: 'completed' | 'failed' | 'timed_out' | 'canceled';
		error?: string | null;
		/** 'interrupted' = the pipe died, not the work: no strike, no reset. */
		judgment?: 'strike' | 'interrupted';
		now?: number;
		/** Validated local-daemon report, committed by the same CAS as the end. */
		finalReport?: {
			usage?: string;
			provider_session_id?: string;
			turn_count?: number;
			conversation_turn_count?: number;
			workspace_path?: string;
			effort_application_status?: import('@tines/shared').EffortApplicationStatus;
			effort_application_evidence?: string;
		};
	}
): Promise<EndRunOutcome> {
	const now = input.now ?? Date.now();
	const started = run.started_at !== null;
	const interrupted = input.judgment === 'interrupted';

	let advanced = false;
	if (started && run.api_key_id) {
		// Authorship by the run's key IS "during the run": the key is minted at
		// delivery and dies with the run, so no time bound is needed — and one
		// would misjudge local runs, where `started_at` lands at the first log
		// flush, possibly *after* an eager agent's transition.
		const transition = await db
			.selectFrom('event')
			.select('id')
			.where('type', '=', 'issue.transitioned')
			.where('actor_api_key_id', '=', run.api_key_id)
			.where('issue_id', '=', run.issue_id)
			.limit(1)
			.executeTakeFirst();
		advanced = transition !== undefined;
	}

	// The judgment itself, decided before the flip so it can ride in it: a
	// run that advanced its issue is `advanced` however it ended (an
	// interrupted run whose agent already transitioned still counts), an
	// interruption is `interrupted`, everything else is a strike.
	const outcome: RunEndOutcome | null = !started
		? null
		: advanced
			? 'advanced'
			: interrupted
				? 'interrupted'
				: 'stalled';

	// The CAS: own the end before any dependent write. The outcome is written
	// here rather than in a follow-up statement, so a losing racer records
	// none and the stored outcome can never disagree with the recorded end.
	const [flip] = await runBatch(env, [
		sql`
			UPDATE agent_run SET status = ${input.status}, error = ${input.error ?? null}, ended_at = ${now},
				outcome = ${outcome},
				${input.finalReport?.usage !== undefined ? sql`usage = ${input.finalReport.usage},` : sql``}
				${input.finalReport?.provider_session_id !== undefined ? sql`provider_session_id = ${input.finalReport.provider_session_id},` : sql``}
				${input.finalReport?.turn_count !== undefined ? sql`turn_count = ${input.finalReport.turn_count},` : sql``}
				${input.finalReport?.conversation_turn_count !== undefined ? sql`conversation_turn_count = ${input.finalReport.conversation_turn_count},` : sql``}
				${input.finalReport?.workspace_path !== undefined ? sql`workspace_path = ${input.finalReport.workspace_path},` : sql``}
				${input.finalReport?.effort_application_status !== undefined ? sql`effort_application_status = ${input.finalReport.effort_application_status},` : sql``}
				${input.finalReport?.effort_application_evidence !== undefined ? sql`effort_application_evidence = ${input.finalReport.effort_application_evidence},` : sql``}
				state_id_at_end = (SELECT state_id FROM issue WHERE id = ${run.issue_id})
			WHERE id = ${run.id} AND status IN (${sql.join(ACTIVE)})`.compile(db)
	]);
	if ((flip?.meta.changes ?? 0) === 0) return { ended: false, outcome: null, parked: false };

	const [issue, settings, runner] = await Promise.all([
		db
			.selectFrom('issue')
			.select(['id', 'project_id', 'state_id', 'attempt_count', 'needs_attention'])
			.where('id', '=', run.issue_id)
			.executeTakeFirst(),
		loadDispatchSettings(db, run.user_id),
		db.selectFrom('runner').select('name').where('id', '=', run.runner_id).executeTakeFirst()
	]);
	const strike = outcome === 'stalled';

	const flipGuard = sql<boolean>`EXISTS (
		SELECT 1 FROM agent_run WHERE id = ${run.id} AND status = ${input.status} AND ended_at = ${now}
	)`;
	const queries: CompiledQuery[] = [
		// The run key dies with the run.
		db
			.updateTable('api_key')
			.set({ revoked_at: now })
			.where('agent_run_id', '=', run.id)
			.where('revoked_at', 'is', null)
			.where(flipGuard)
			.compile()
	];
	// An interruption touches the issue's budget in neither direction: it is
	// not a strike, and it is not a reset either — the attempt that the pipe
	// swallowed simply never happened.
	if (issue && (advanced || strike)) {
		queries.push(
			advanced
				? db
						.updateTable('issue')
						.set({ attempt_count: 0 })
						.where('id', '=', issue.id)
						.where(flipGuard)
						.compile()
				: // In-statement increment and park predicate: correct even if a
					// manual reset lands between the read above and this write.
					sql`
						UPDATE issue SET
							attempt_count = attempt_count + 1,
							needs_attention = CASE WHEN attempt_count + 1 >= ${settings.attemptLimit} THEN 1 ELSE needs_attention END
						WHERE id = ${issue.id} AND ${flipGuard}`.compile(db)
		);
	}
	queries.push(
		supervisorEvent(
			db,
			run.user_id,
			{
				type: 'agent_run.ended',
				issueId: run.issue_id,
				projectId: issue?.project_id,
				payload: {
					run_id: run.id,
					runner_id: run.runner_id,
					runner_name: runner?.name ?? 'removed runner',
					status: input.status,
					...(outcome ? { outcome } : {}),
					state_id_at_start: run.state_id_at_start,
					state_id_at_end: issue?.state_id ?? null,
					...(input.finalReport?.usage || run.usage
						? {
								usage: JSON.parse(input.finalReport?.usage ?? run.usage!) as Record<string, unknown>
							}
						: {}),
					...(input.error ? { error: input.error } : {})
				}
			},
			now,
			flipGuard
		)
	);
	// The parked event fires iff the increment above actually parked the
	// issue — evaluated in-statement, after the update, in the same batch.
	if (strike && issue) {
		queries.push(
			supervisorEvent(
				db,
				run.user_id,
				{
					type: 'issue.parked',
					issueId: issue.id,
					projectId: issue.project_id,
					payload: {
						run_id: run.id,
						attempt_count: issue.attempt_count + 1,
						attempt_limit: settings.attemptLimit
					}
				},
				now,
				sql<boolean>`${flipGuard} AND EXISTS (
					SELECT 1 FROM issue WHERE id = ${issue.id}
						AND needs_attention = 1 AND attempt_count >= ${settings.attemptLimit}
				)`
			)
		);
	}
	const results = await runBatch(env, queries);
	// Whether the park landed is the last statement's rows-affected.
	const parked =
		strike && issue !== undefined && (results[results.length - 1]?.meta.changes ?? 0) === 1;
	// Seal the full log into one object now that the status flip has closed
	// the tail to further appends. Best-effort by design: a run must never
	// fail to end because R2 was unavailable — the sweep retries unsealed runs.
	try {
		const sealable = await loadSealableRun(db, run.id);
		if (sealable) await sealRunLog(db, env, sealable);
	} catch (e) {
		console.error(`sealing the full log for run ${run.id} failed:`, e);
	}
	return { ended: true, outcome, parked };
}

/** Loads a run in the shape endRun needs, scoped to the user. */
export async function loadEndableRun(
	db: Kysely<Database>,
	userId: string,
	runId: string
): Promise<EndableRun | undefined> {
	return db
		.selectFrom('agent_run')
		.select([
			'id',
			'user_id',
			'issue_id',
			'runner_id',
			'status',
			'api_key_id',
			'started_at',
			'state_id_at_start',
			'provider_session_id',
			'usage'
		])
		.where('id', '=', runId)
		.where('user_id', '=', userId)
		.executeTakeFirst();
}

export type CancelRunResult =
	{ kind: 'not_found' } | { kind: 'already_ended' } | { kind: 'canceled' };

/**
 * Cancels a run: best-effort adapter kill, then an ordinary end judged like
 * any other (a strike unless the agent had already transitioned the issue;
 * a never-started `assigned` run cancels free of judgment).
 */
export async function cancelRun(
	db: Kysely<Database>,
	env: Env,
	userId: string,
	runId: string,
	adapters?: AdapterRegistry
): Promise<CancelRunResult> {
	adapters ??= buildAdapters(env);
	const run = await loadEndableRun(db, userId, runId);
	if (!run) return { kind: 'not_found' };
	if (!(ACTIVE as string[]).includes(run.status)) return { kind: 'already_ended' };

	const runner = await db
		.selectFrom('runner')
		.select(['type'])
		.where('id', '=', run.runner_id)
		.executeTakeFirst();
	const adapter = runner ? adapters[runner.type] : undefined;
	if (adapter) {
		try {
			await adapter.cancel({
				id: run.id,
				runner_id: run.runner_id,
				provider_session_id: run.provider_session_id
			});
		} catch (e) {
			// Best-effort: a dead session is what we wanted anyway.
			console.error(`adapter cancel for run ${run.id} failed:`, e);
		}
	}
	const outcome = await endRun(db, env, run, { status: 'canceled' });
	return outcome.ended ? { kind: 'canceled' } : { kind: 'already_ended' };
}

/**
 * Cancels not-yet-acknowledged `assigned` runs — free cancels: nothing is
 * running yet, so no judgment applies and the issues return to the pool.
 * Runner pause cancels its own; the kill switch turning off cancels
 * fleet-wide (SPEC.md "Pausing a runner"). `onCanceled` is a required,
 * synchronous, non-throwing notification at each durable cancellation win.
 */
export async function cancelAssignedRuns(
	db: Kysely<Database>,
	env: Env,
	scope: { userId: string; runnerId?: string },
	reason: string,
	onCanceled: () => void,
	now: number = Date.now()
): Promise<number> {
	let q = db
		.selectFrom('agent_run')
		.select('id')
		.where('user_id', '=', scope.userId)
		.where('status', '=', 'assigned');
	if (scope.runnerId) q = q.where('runner_id', '=', scope.runnerId);
	const rows = await q.execute();
	let canceled = 0;
	for (const row of rows) {
		const run = await loadEndableRun(db, scope.userId, row.id);
		// Delivered (or settled) in the meantime: no longer a free cancel.
		if (!run || run.status !== 'assigned') continue;
		const outcome = await endRun(db, env, run, { status: 'canceled', error: reason, now });
		if (outcome.ended) {
			onCanceled();
			canceled += 1;
		}
	}
	return canceled;
}

/**
 * Flips a delivered run `launching → running` — the daemon's first log
 * append, or a finish arriving before any output — recording `started_at`
 * and the `agent_run.started` event. False = the run was not in `launching`
 * (already running, or settled); losing the CAS writes nothing.
 */
export async function markRunRunning(
	db: Kysely<Database>,
	env: Env,
	run: {
		id: string;
		user_id: string;
		issue_id: string;
		runner_id: string;
		tier: string;
		model: string | null;
	},
	now: number
): Promise<boolean> {
	// Event payload lookups happen before the batch (wasted only on a lost
	// CAS); the event itself is guarded on the flip landing in the same
	// batch, so flip and started-event commit together — the same shape as
	// launchClaimedRun's startedGuard.
	const [runner, issue] = await Promise.all([
		db.selectFrom('runner').select('name').where('id', '=', run.runner_id).executeTakeFirst(),
		db.selectFrom('issue').select('project_id').where('id', '=', run.issue_id).executeTakeFirst()
	]);
	const flipGuard = sql<boolean>`EXISTS (
		SELECT 1 FROM agent_run WHERE id = ${run.id} AND status = 'running' AND started_at = ${now}
	)`;
	const [flip] = await runBatch(env, [
		db
			.updateTable('agent_run')
			.set({ status: 'running', started_at: now })
			.where('id', '=', run.id)
			.where('status', '=', 'launching')
			.compile(),
		supervisorEvent(
			db,
			run.user_id,
			{
				type: 'agent_run.started',
				issueId: run.issue_id,
				projectId: issue?.project_id ?? null,
				payload: {
					run_id: run.id,
					runner_id: run.runner_id,
					runner_name: runner?.name ?? 'removed runner',
					tier: run.tier,
					model: run.model
				}
			},
			now,
			flipGuard
		)
	]);
	return (flip?.meta.changes ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// Managed-run polling (sweep-driven; SPEC.md "Monitoring")

/**
 * Polls every running run whose adapter reconciles provider-side: appends
 * the rendered event summary to the log tail, replaces the usage snapshot,
 * advances the adapter's poll cursor, enforces the per-run token cap (the
 * one per-run ceiling Claude sessions cannot enforce natively), and runs the
 * ordinary end judgment when the provider reports the session ended. A
 * throwing poll skips that run until the next sweep.
 */
export async function pollManagedRuns(
	db: Kysely<Database>,
	env: Env,
	now: number,
	adapters: AdapterRegistry
): Promise<void> {
	const rows = await db
		.selectFrom('agent_run')
		.innerJoin('runner', 'runner.id', 'agent_run.runner_id')
		.select(['agent_run.id', 'agent_run.user_id', 'runner.type', 'runner.budget'])
		.where('agent_run.status', '=', 'running')
		.execute();
	for (const row of rows) {
		const adapter = adapters[row.type];
		if (!adapter?.poll) continue;
		try {
			const run = await db
				.selectFrom('agent_run')
				.selectAll()
				.where('id', '=', row.id)
				.executeTakeFirst();
			if (!run || run.status !== 'running') continue;
			const polled = await adapter.poll({
				id: run.id,
				runner_id: run.runner_id,
				provider_session_id: run.provider_session_id,
				provider_meta: run.provider_meta
			});

			const patch: Partial<Database['agent_run']> = {};
			if (polled.logChunk) {
				const appended = appendLogTail(run.log, run.log_bytes_dropped, polled.logChunk);
				patch.log = appended.log;
				patch.log_bytes_dropped = appended.dropped;
				// Managed runs' rendered event summaries spill and are retained
				// exactly like a local daemon's stdout: one writer, no seq needed.
				if (appended.evicted) {
					const spill = await spillEvicted(env, run, appended.evicted);
					patch.log_part_count = spill.log_part_count;
				}
			}
			if (polled.usage) patch.usage = JSON.stringify(polled.usage);
			if (polled.provider_meta !== undefined) patch.provider_meta = polled.provider_meta;
			if (Object.keys(patch).length > 0) {
				await runBatch(env, [
					db
						.updateTable('agent_run')
						.set(patch)
						.where('id', '=', run.id)
						// A poll racing a cancel/sweep must not extend a settled run.
						.where('status', 'in', ACTIVE)
						.compile()
				]);
			}

			let terminal: {
				status: 'completed' | 'failed' | 'timed_out' | 'canceled';
				error: string | null;
			} | null = polled.status ? { status: polled.status, error: polled.error ?? null } : null;
			if (!terminal && polled.usage) {
				// The token cap has no provider-native ceiling on Claude; enforce
				// it at poll time (input + output — cache reads excluded).
				let budget: RunnerBudget | null = null;
				try {
					budget = row.budget ? (JSON.parse(row.budget) as RunnerBudget) : null;
				} catch {
					// An unreadable budget column enforces nothing.
				}
				const tokens = (polled.usage.input_tokens ?? 0) + (polled.usage.output_tokens ?? 0);
				if (budget?.max_run_tokens !== undefined && tokens > budget.max_run_tokens) {
					await adapter
						.cancel({
							id: run.id,
							runner_id: run.runner_id,
							provider_session_id: run.provider_session_id,
							provider_meta: run.provider_meta
						})
						.catch((e) => console.error(`adapter cancel for run ${run.id} failed:`, e));
					terminal = {
						status: 'failed',
						error: `run exceeded max_run_tokens (${budget.max_run_tokens})`
					};
				}
			}
			if (terminal) {
				const endable = await loadEndableRun(db, row.user_id, run.id);
				if (endable && (ACTIVE as string[]).includes(endable.status)) {
					const outcome = await endRun(db, env, endable, {
						status: terminal.status,
						error: terminal.error,
						now
					});
					// Provider resources outlive the run only if the server's own
					// end judgment says so; the adapter never decides retention
					// from a provider status alone.
					if (outcome.ended && adapter.finalizeEnd) {
						const ended = await db
							.selectFrom('agent_run')
							.leftJoin('workflow_state as st', 'st.id', 'agent_run.state_id_at_end')
							.select([
								'agent_run.outcome',
								'agent_run.issue_id',
								'agent_run.model',
								'agent_run.resolved_effort',
								'st.category'
							])
							.where('agent_run.id', '=', run.id)
							.executeTakeFirst();
						await adapter
							.finalizeEnd(
								{
									id: run.id,
									runner_id: run.runner_id,
									provider_session_id: run.provider_session_id,
									provider_meta: run.provider_meta
								},
								{
									user_id: row.user_id,
									issue_id: ended?.issue_id ?? run.issue_id,
									model: ended?.model ?? null,
									effort: ended?.resolved_effort ?? null,
									outcome: ended?.outcome ?? outcome.outcome,
									ended_in_awaiting_state: ended?.category === 'awaiting_human',
									now
								}
							)
							.catch((err) => console.error(`adapter finalizeEnd for run ${run.id} failed:`, err));
					}
				}
			}
		} catch (e) {
			console.error(`supervisor sweep: polling run ${row.id} failed:`, e);
		}
	}
}

// ---------------------------------------------------------------------------
// The sweep: the reliability guarantee behind the opportunistic passes

export async function sweepSupervisor(
	db: Kysely<Database>,
	env: Env,
	now: number = Date.now(),
	adapters?: AdapterRegistry
): Promise<void> {
	adapters ??= buildAdapters(env);

	// Managed-run polling: reconcile provider-side status, usage, and the
	// rendered event summary for every running run whose adapter polls. Runs
	// the provider reports ended get the ordinary end judgment; per-run token
	// caps (no provider-native ceiling on Claude sessions) are enforced here.
	await pollManagedRuns(db, env, now, adapters);

	// Timeout enforcement: running runs past their runner's max_run_minutes.
	const overdue = await db
		.selectFrom('agent_run')
		.innerJoin('runner', 'runner.id', 'agent_run.runner_id')
		.select(['agent_run.id', 'agent_run.user_id', 'runner.type', 'runner.max_run_minutes'])
		.where('agent_run.status', '=', 'running')
		.where(sql<boolean>`agent_run.started_at + runner.max_run_minutes * 60000 <= ${now}`)
		.execute();
	for (const row of overdue) {
		try {
			const run = await loadEndableRun(db, row.user_id, row.id);
			if (!run || run.status !== 'running') continue;
			const adapter = adapters[row.type];
			if (adapter) {
				await adapter
					.cancel({
						id: run.id,
						runner_id: run.runner_id,
						provider_session_id: run.provider_session_id
					})
					.catch((e) => console.error(`adapter cancel for run ${run.id} failed:`, e));
			}
			await endRun(db, env, run, {
				status: 'timed_out',
				error: `run exceeded max_run_minutes (${row.max_run_minutes})`,
				now
			});
		} catch (e) {
			console.error(`supervisor sweep: timing out run ${row.id} failed:`, e);
		}
	}

	// A local runner offline >5 minutes must not hold claims: its running —
	// and delivered-but-not-yet-running (`launching`) — runs fail now (error
	// `runner offline`, keys revoked by endRun). `launching` is included
	// because a delivered local run only leaves that status at the daemon's
	// first log flush: with the daemon dead, no other arm would reap it (the
	// launch-stall arm below deliberately skips poll-mode runs).
	const orphaned = await db
		.selectFrom('agent_run')
		.innerJoin('runner', 'runner.id', 'agent_run.runner_id')
		.select(['agent_run.id', 'agent_run.user_id', 'agent_run.status', 'agent_run.runner_id'])
		.where('agent_run.status', 'in', ['launching', 'running'])
		.where('runner.type', '=', 'local')
		.where((eb) =>
			eb.or([
				eb('runner.last_seen_at', 'is', null),
				eb('runner.last_seen_at', '<=', now - RUNNER_OFFLINE_FAIL_MS)
			])
		)
		.execute();
	// The disappearance is the pipe failing, not the issue: these ends are
	// judged `interrupted` (no strike, no reset) and the pressure lands on
	// the runner instead — once per runner, since one dead daemon takes down
	// every run it held.
	const interruptedRunners = new Map<string, string>();
	for (const row of orphaned) {
		try {
			const run = await loadEndableRun(db, row.user_id, row.id);
			if (!run || (run.status !== 'running' && run.status !== 'launching')) continue;
			const ended = await endRun(db, env, run, {
				status: 'failed',
				error: 'runner offline',
				judgment: 'interrupted',
				now
			});
			// Only a run that had actually started is evidence of a runner
			// dying mid-work; a never-started `launching` run is not judged at
			// all (`outcome` null) and the launch-stall arm owns that story.
			if (ended.outcome === 'interrupted') interruptedRunners.set(row.runner_id, row.user_id);
		} catch (e) {
			console.error(`supervisor sweep: failing offline run ${row.id} failed:`, e);
		}
	}
	for (const [runnerId, userId] of interruptedRunners) {
		try {
			await noteInterruption(db, env, { userId, runnerId, error: 'runner offline', now });
		} catch (e) {
			console.error(`supervisor sweep: noting offline runner ${runnerId} failed:`, e);
		}
	}

	// Launch reconciliation: `assigned` runs never acknowledged and
	// `launching` runs with no recorded session are launch failures — the
	// issue retries, the runner backs off.
	const stalled = await db
		.selectFrom('agent_run')
		.selectAll('agent_run')
		.where('created_at', '<=', now - LAUNCH_STALL_MS)
		.where((eb) =>
			eb.or([
				eb('status', '=', 'assigned'),
				eb.and([eb('status', '=', 'launching'), eb('provider_session_id', 'is', null)])
			])
		)
		.execute();
	for (const run of stalled) {
		try {
			const runner = await db
				.selectFrom('runner')
				.selectAll()
				.where('id', '=', run.runner_id)
				.executeTakeFirst();
			if (!runner) continue;
			// The `launching` arm is provider reconciliation only. A poll-mode
			// (local) run never records a session and leaves `launching` at the
			// daemon's first log flush — a quiet harness five minutes into a
			// delivered run is healthy, not stalled. Its liveness is covered by
			// `owned_runs`, the offline rule, and the `assigned` arm above.
			if (run.status === 'launching' && adapters[runner.type]?.launchMode === 'poll') continue;
			await failLaunch(db, env, {
				userId: run.user_id,
				runId: run.id,
				runner,
				error:
					run.status === 'assigned'
						? 'assignment not acknowledged within 5 minutes'
						: 'no provider session recorded within 5 minutes of launch',
				now
			});
		} catch (e) {
			console.error(`supervisor sweep: failing stalled run ${run.id} failed:`, e);
		}
	}

	// Full run logs: compact spilled parts, seal ended runs whose inline seal
	// did not land, drop objects past retention, and sweep orphans.
	try {
		await sweepRunLogs(db, env, now);
	} catch (e) {
		console.error('supervisor sweep: run-log housekeeping failed:', e);
	}

	// Expired run keys die even if their run's end was never detected.
	await runBatch(env, [
		db
			.updateTable('api_key')
			.set({ revoked_at: now })
			.where('agent_run_id', 'is not', null)
			.where('revoked_at', 'is', null)
			.where('expires_at', '<=', now)
			.compile()
	]);

	// Retained resume resources past their window: disposed here so a kept
	// workspace cannot be continued (or pinned) forever. Best-effort.
	try {
		await disposeExpiredResumeResources(db, now);
	} catch (e) {
		console.error('supervisor sweep: expired resume resources failed:', e);
	}

	// Per-runner provider housekeeping (managed types): garbage-collect ended
	// runs' vault credentials and sessions, and cancel orphaned sessions
	// tagged with unknown/ended run ids (launch reconciliation's provider
	// half). Best-effort; failures retry next sweep.
	const sweepable = await db.selectFrom('runner').select(['id', 'user_id', 'type']).execute();
	for (const runner of sweepable) {
		const adapter = adapters[runner.type];
		if (!adapter?.sweepRunner) continue;
		try {
			await adapter.sweepRunner({ id: runner.id, user_id: runner.user_id }, now);
		} catch (e) {
			console.error(`supervisor sweep: provider housekeeping for runner ${runner.id} failed:`, e);
		}
	}

	// The dispatch pass itself — for every issue owner whose automation is
	// effectively enabled. Missing settings inherit enabled; saved stops do not.
	// is also what retries launch-failure backoff: an expired backoff_until
	// simply stops excluding the runner.
	const enabled = await db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.leftJoin('supervisor_settings', 'supervisor_settings.user_id', 'project.user_id')
		.select('project.user_id as user_id')
		.where((eb) =>
			eb.or([
				eb('supervisor_settings.enabled', 'is', null),
				eb('supervisor_settings.enabled', '=', 1)
			])
		)
		.distinct()
		.execute();
	for (const row of enabled) {
		try {
			await runDispatchPass(db, env, row.user_id, { now, adapters });
		} catch (e) {
			console.error(`supervisor sweep: dispatch pass for ${row.user_id} failed:`, e);
		}
	}
}
