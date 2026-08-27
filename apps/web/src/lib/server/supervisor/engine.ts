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
	type RoutingTarget
} from '@tines/shared';
import type { D1Result } from '@cloudflare/workers-types';
import { sql, type CompiledQuery, type Kysely, type RawBuilder } from 'kysely';
import { sha256Hex } from '../crypto';
import { getDb, newId, randomString, type Database } from '../db';
import { defaultAdapters, type AdapterRegistry, type RunnerAdapter } from './adapter';
import {
	launchBackoffMs,
	matchRule,
	resolveTier,
	targetVerdict,
	type ActiveCounts,
	type MatchableRule
} from './logic';

const ACTIVE = [...ACTIVE_RUN_STATUSES];

export interface DispatchPassOptions {
	now?: number;
	adapters?: AdapterRegistry;
}

// ---------------------------------------------------------------------------
// Small local plumbing (core.ts is off-limits here: it imports @sveltejs/kit)

async function runBatch(env: Env, queries: CompiledQuery[]): Promise<D1Result[]> {
	if (queries.length === 0) return [];
	return env.DB.batch(queries.map((q) => env.DB.prepare(q.sql).bind(...(q.parameters as unknown[]))));
}

/**
 * Supervisor-initiated event: attributed to the owning user with no API key
 * (the schedules-sweep pattern); the run is identified in the payload. An
 * optional guard ties the insert to another statement in the same batch.
 */
function supervisorEvent(
	db: Kysely<Database>,
	userId: string,
	input: { type: string; issueId?: string | null; projectId?: string | null; payload: Record<string, unknown> },
	now: number,
	guard?: RawBuilder<boolean>
): CompiledQuery {
	return sql`
		INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
		SELECT ${newId('evt')}, ${userId}, ${input.type}, ${userId}, ${null},
			${input.issueId ?? null}, ${input.projectId ?? null}, ${JSON.stringify(input.payload)}, ${now}
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
	// No row = the defaults, kill switch off (arming automation is explicit).
	if (!row) return { enabled: false, quota: DEFAULT_QUOTA, attemptLimit: 3 };
	let quota = DEFAULT_QUOTA;
	try {
		quota = JSON.parse(row.quota) as QuotaPolicy;
	} catch {
		// Unreadable policy column falls back to the default.
	}
	return { enabled: row.enabled === 1, quota, attemptLimit: row.attempt_limit };
}

export interface CandidateIssue {
	id: string;
	project_id: string;
	state_id: string;
	updated_at: number;
	pinned_runner_id: string | null;
	pinned_tier: string | null;
}

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
): Promise<CandidateIssue[]> {
	const result = await sql<CandidateIssue>`
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
			issue.pinned_runner_id, issue.pinned_tier
		FROM issue
		JOIN project ON project.id = issue.project_id
		JOIN workflow_state st ON st.id = issue.state_id
		WHERE project.user_id = ${userId}
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
	return result.rows;
}

export async function loadActiveCounts(db: Kysely<Database>, userId: string): Promise<ActiveCounts> {
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
		.select(['id', 'project_id', 'workflow_state_id', 'targets'])
		.where('user_id', '=', userId)
		.execute();
	return rows.map((r) => {
		let targets: RoutingTarget[] = [];
		try {
			targets = JSON.parse(r.targets) as RoutingTarget[];
		} catch {
			// An unreadable target list dispatches nothing rather than crashing.
		}
		return { id: r.id, project_id: r.project_id, workflow_state_id: r.workflow_state_id, targets };
	});
}

/** The targets to walk for an issue: the pin replaces rule matching entirely. */
export function targetsForIssue(
	issue: CandidateIssue,
	rules: EngineRule[]
): { targets: RoutingTarget[]; rule: EngineRule | null; pinned: boolean } {
	if (issue.pinned_runner_id) {
		return {
			targets: [
				{ runner_id: issue.pinned_runner_id, tier: (issue.pinned_tier as ModelTier | null) ?? null }
			],
			rule: null,
			pinned: true
		};
	}
	const rule = matchRule({ project_id: issue.project_id, state_id: issue.state_id }, rules);
	return { targets: rule?.targets ?? [], rule, pinned: false };
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
		stateId: string;
		runnerId: string;
		maxConcurrent: number;
		tier: ModelTier;
		model: string | null;
		quota: QuotaPolicy;
		now: number;
	}
): Promise<boolean> {
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
			state_id_at_start, log, log_bytes_dropped, created_at)
		SELECT ${input.runId}, ${input.userId}, issue.id, ${input.runnerId}, 'assigned',
			${input.tier}, ${input.model}, issue.state_id, '', 0, ${input.now}
		FROM issue
		JOIN workflow_state st ON st.id = issue.state_id
		WHERE issue.id = ${input.issueId}
			AND issue.state_id = ${input.stateId}
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
		now: number;
	}
): Promise<LaunchOutcome> {
	const { runner } = ctx;
	const secret = `tines_${randomString(40)}`;
	const keyId = newId('key');
	const [, flip] = await runBatch(env, [
		db
			.insertInto('api_key')
			.values({
				id: keyId,
				user_id: ctx.userId,
				name: `run ${ctx.runId}`,
				key_hash: await sha256Hex(secret),
				key_prefix: secret.slice(0, 14),
				agent_run_id: ctx.runId,
				expires_at: ctx.now + runner.max_run_minutes * 60_000 + RUN_KEY_SLACK_MS,
				created_at: ctx.now,
				last_used_at: null,
				revoked_at: null
			})
			.compile(),
		db
			.updateTable('agent_run')
			.set({ status: 'launching', api_key_id: keyId })
			.where('id', '=', ctx.runId)
			.where('status', '=', 'assigned')
			.compile()
	]);
	if ((flip?.meta.changes ?? 0) === 0) {
		// The run was ended (canceled or swept) between the claim and this
		// flip. The key minted alongside it post-dates endRun's revocation
		// sweep, so it must die here — and no provider session is created.
		await runBatch(env, [
			db.updateTable('api_key').set({ revoked_at: ctx.now }).where('id', '=', keyId).compile()
		]);
		return 'lost';
	}

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
					provider_url: launched.provider_url ?? null
				})
				.where('id', '=', ctx.runId)
				.where('status', '=', 'launching')
				.compile(),
			// A successful launch clears the failure count and backoff.
			db
				.updateTable('runner')
				.set({ launch_failures: 0, backoff_until: null })
				.where('id', '=', runner.id)
				.where('launch_failures', '>', 0)
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
				backoff_until: input.now + launchBackoffMs(failures)
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
	const adapters = opts.adapters ?? defaultAdapters;
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

	for (const issue of candidates) {
		// With the global cap saturated nothing more can dispatch this pass.
		if (settings.quota.type === 'global_cap' && counts.total >= settings.quota.limit) break;
		const { targets } = targetsForIssue(issue, rules);
		for (const target of targets) {
			const runner = runners.get(target.runner_id);
			if (!runner) continue; // stale target (runner removed mid-pass)
			const adapter = adapters[runner.type];
			if (!adapter) continue;
			const { verdict } = targetVerdict(runner, counts, settings.quota, issue.state_id, now);
			if (verdict !== 'ok') continue;

			const resolved = resolveTier(runner, target.tier ?? null);
			const runId = newId('arun');
			const claimed = await claimRun(db, env, {
				runId,
				userId,
				issueId: issue.id,
				stateId: issue.state_id,
				runnerId: runner.id,
				maxConcurrent: runner.max_concurrent,
				tier: resolved.tier,
				model: resolved.model,
				quota: settings.quota,
				now
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
		}
	}
	return result;
}

/**
 * Schedules an opportunistic pass on the platform's waitUntil — the fast
 * path after any eligibility-changing write. Failures are invisible by
 * design; the sweep is the reliability guarantee.
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
	outcome: 'advanced' | 'stalled' | null;
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
	input: { status: 'completed' | 'failed' | 'timed_out' | 'canceled'; error?: string | null; now?: number }
): Promise<EndRunOutcome> {
	const now = input.now ?? Date.now();
	const started = run.started_at !== null;

	let advanced = false;
	if (started && run.api_key_id) {
		const transition = await db
			.selectFrom('event')
			.select('id')
			.where('type', '=', 'issue.transitioned')
			.where('actor_api_key_id', '=', run.api_key_id)
			.where('issue_id', '=', run.issue_id)
			.where('created_at', '>=', run.started_at!)
			.limit(1)
			.executeTakeFirst();
		advanced = transition !== undefined;
	}

	// The CAS: own the end before any dependent write.
	const [flip] = await runBatch(env, [
		sql`
			UPDATE agent_run SET status = ${input.status}, error = ${input.error ?? null}, ended_at = ${now},
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
	const strike = started && !advanced;

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
	if (started && issue) {
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
					...(started ? { outcome: advanced ? 'advanced' : 'stalled' } : {}),
					state_id_at_start: run.state_id_at_start,
					state_id_at_end: issue?.state_id ?? null,
					...(run.usage ? { usage: JSON.parse(run.usage) as Record<string, unknown> } : {}),
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
	const parked = strike && issue !== undefined && (results[results.length - 1]?.meta.changes ?? 0) === 1;
	return {
		ended: true,
		outcome: started ? (advanced ? 'advanced' : 'stalled') : null,
		parked
	};
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

export type CancelRunResult = { kind: 'not_found' } | { kind: 'already_ended' } | { kind: 'canceled' };

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
	adapters: AdapterRegistry = defaultAdapters
): Promise<CancelRunResult> {
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

// ---------------------------------------------------------------------------
// The sweep: the reliability guarantee behind the opportunistic passes

export async function sweepSupervisor(
	db: Kysely<Database>,
	env: Env,
	now: number = Date.now(),
	adapters: AdapterRegistry = defaultAdapters
): Promise<void> {
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

	// A local runner offline >5 minutes must not hold claims: its running
	// runs fail now (error `runner offline`, keys revoked by endRun).
	const orphaned = await db
		.selectFrom('agent_run')
		.innerJoin('runner', 'runner.id', 'agent_run.runner_id')
		.select(['agent_run.id', 'agent_run.user_id'])
		.where('agent_run.status', '=', 'running')
		.where('runner.type', '=', 'local')
		.where((eb) =>
			eb.or([
				eb('runner.last_seen_at', 'is', null),
				eb('runner.last_seen_at', '<=', now - RUNNER_OFFLINE_FAIL_MS)
			])
		)
		.execute();
	for (const row of orphaned) {
		try {
			const run = await loadEndableRun(db, row.user_id, row.id);
			if (!run || run.status !== 'running') continue;
			await endRun(db, env, run, { status: 'failed', error: 'runner offline', now });
		} catch (e) {
			console.error(`supervisor sweep: failing offline run ${row.id} failed:`, e);
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

	// The dispatch pass itself — for every user with automation armed. This
	// is also what retries launch-failure backoff: an expired backoff_until
	// simply stops excluding the runner.
	const enabled = await db
		.selectFrom('supervisor_settings')
		.select('user_id')
		.where('enabled', '=', 1)
		.execute();
	for (const row of enabled) {
		try {
			await runDispatchPass(db, env, row.user_id, { now, adapters });
		} catch (e) {
			console.error(`supervisor sweep: dispatch pass for ${row.user_id} failed:`, e);
		}
	}
}
