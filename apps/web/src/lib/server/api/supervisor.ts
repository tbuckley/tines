import {
	ACTIVE_RUN_STATUSES,
	QUEUE_GROUP_REF_LIMIT,
	type FleetQueue,
	type ChangeMarker,
	type QueueBinding,
	type QueueGroup,
	type QueueIssueRef,
	type QueueVerdict,
	type QuotaPolicy,
	type RunEndOutcome,
	type SentBackDrilldown,
	type StageStatsReport,
	type StatsQuery,
	type SupervisorSettings,
	type SupervisorSettingsResponse,
	type UpdateSupervisorSettingsRequest
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import { encryptSecret, secretHint } from '$lib/server/crypto';
import type { Database } from '$lib/server/db';
import {
	cancelAssignedRuns,
	cancelRun,
	loadActiveCounts,
	loadDispatchSettings,
	loadEligibleIssues,
	loadEngineRules,
	loadEngineRunners,
	targetsForIssue,
	type EngineRunner
} from '$lib/server/supervisor/engine';
import {
	isRoutedCandidate,
	queueVerdict,
	quotaLimitForState,
	speakingTarget,
	targetVerdict,
	type ActiveCounts,
	type TargetVerdictResult
} from '$lib/server/supervisor/logic';
import { computeStageStats, type StatsEvent } from '$lib/server/supervisor/stats';
import { ApiFail, requireString, runAtomic, type ActorContext } from './core';
import { applyEventWindow, eventInsert, eventQuery, serializeEvent } from './events';

// ---------------------------------------------------------------------------
// Defaults & validation

/** The defaults a user has before ever writing the settings row. */
export const DEFAULT_QUOTA: QuotaPolicy = { type: 'global_cap', limit: 3 };
export const DEFAULT_ATTEMPT_LIMIT = 3;

function fail(message: string, details?: Record<string, unknown>): ApiFail {
	return new ApiFail(422, 'invalid_quota', message, { field: 'quota', ...details });
}

/**
 * Validates a typed quota policy. `global_cap` needs a positive limit (0 is
 * the kill switch's job); `state_roster` limits may be 0 — "no agents work
 * this stage" is a meaningful roster entry. Override keys are state ids,
 * checked against the DB by the caller.
 */
export function validateQuotaPolicy(value: unknown): QuotaPolicy {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw fail('"quota" must be a typed policy object ({ "type": … })');
	}
	const quota = value as Record<string, unknown>;
	if (quota.type === 'global_cap') {
		const extra = Object.keys(quota).filter((k) => !['type', 'limit'].includes(k));
		if (extra.length > 0) {
			throw fail(`Unknown global_cap field${extra.length === 1 ? '' : 's'}: ${extra.join(', ')}`);
		}
		if (
			typeof quota.limit !== 'number' ||
			!Number.isInteger(quota.limit) ||
			quota.limit < 1 ||
			quota.limit > 100
		) {
			throw fail('"quota.limit" must be an integer between 1 and 100');
		}
		return { type: 'global_cap', limit: quota.limit };
	}
	if (quota.type === 'state_roster') {
		const extra = Object.keys(quota).filter(
			(k) => !['type', 'default_limit', 'overrides'].includes(k)
		);
		if (extra.length > 0) {
			throw fail(`Unknown state_roster field${extra.length === 1 ? '' : 's'}: ${extra.join(', ')}`);
		}
		const def = quota.default_limit;
		if (typeof def !== 'number' || !Number.isInteger(def) || def < 0 || def > 100) {
			throw fail('"quota.default_limit" must be an integer between 0 and 100');
		}
		const rawOverrides = quota.overrides ?? {};
		if (typeof rawOverrides !== 'object' || rawOverrides === null || Array.isArray(rawOverrides)) {
			throw fail('"quota.overrides" must be an object mapping state ids to limits');
		}
		const overrides: Record<string, number> = {};
		for (const [stateId, limit] of Object.entries(rawOverrides as Record<string, unknown>)) {
			if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > 100) {
				throw fail(`"quota.overrides['${stateId}']" must be an integer between 0 and 100`, {
					state_id: stateId
				});
			}
			overrides[stateId] = limit;
		}
		return { type: 'state_roster', default_limit: def, overrides };
	}
	throw fail(
		`Unknown quota policy type ${JSON.stringify(quota.type)}; allowed: global_cap, state_roster`,
		{ allowed_types: ['global_cap', 'state_roster'] }
	);
}

export function validateAttemptLimit(value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
		throw new ApiFail(
			422,
			'invalid_field',
			'"attempt_limit" must be an integer between 1 and 100',
			{
				field: 'attempt_limit'
			}
		);
	}
	return value;
}

/** Roster override keys must be real workflow states the user can see. */
async function assertRosterStatesExist(
	db: Kysely<Database>,
	userId: string,
	quota: QuotaPolicy
): Promise<void> {
	if (quota.type !== 'state_roster') return;
	const stateIds = Object.keys(quota.overrides);
	if (stateIds.length === 0) return;
	const rows = await db
		.selectFrom('workflow_state')
		.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
		.select('workflow_state.id')
		.where('workflow_state.id', 'in', stateIds)
		.where((eb) => eb.or([eb('workflow.user_id', '=', userId), eb('workflow.user_id', 'is', null)]))
		.execute();
	const known = new Set(rows.map((r) => r.id));
	const missing = stateIds.filter((id) => !known.has(id));
	if (missing.length > 0) {
		throw new ApiFail(
			422,
			'unknown_state',
			`Roster override state${missing.length === 1 ? '' : 's'} ${missing.map((id) => `"${id}"`).join(', ')} do${missing.length === 1 ? 'es' : ''} not exist`,
			{ field: 'quota', unknown_state_ids: missing }
		);
	}
}

// ---------------------------------------------------------------------------
// Read / write

export async function getSupervisorSettings(
	db: Kysely<Database>,
	userId: string
): Promise<SupervisorSettings> {
	const row = await db
		.selectFrom('supervisor_settings')
		.selectAll()
		.where('user_id', '=', userId)
		.executeTakeFirst();
	if (!row) {
		// No row yet: the defaults, with the kill switch off — arming
		// automation is its own explicit act for a new user.
		return {
			enabled: false,
			quota: DEFAULT_QUOTA,
			attempt_limit: DEFAULT_ATTEMPT_LIMIT,
			github_pat_hint: null,
			updated_at: null
		};
	}
	let quota = DEFAULT_QUOTA;
	try {
		quota = JSON.parse(row.quota) as QuotaPolicy;
	} catch {
		// An unreadable quota column falls back to the default policy.
	}
	return {
		enabled: row.enabled === 1,
		quota,
		attempt_limit: row.attempt_limit,
		// The PAT is write-only: only its display hint is ever read back.
		github_pat_hint: row.github_pat_hint,
		updated_at: row.updated_at
	};
}

export async function updateSupervisorSettings(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	body: UpdateSupervisorSettingsRequest
): Promise<SupervisorSettingsResponse> {
	const current = await getSupervisorSettings(db, actor.userId);

	let enabled = current.enabled;
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== 'boolean') {
			throw new ApiFail(422, 'invalid_field', '"enabled" must be a boolean', { field: 'enabled' });
		}
		enabled = body.enabled;
	}
	if (body.cancel_in_flight !== undefined && typeof body.cancel_in_flight !== 'boolean') {
		throw new ApiFail(422, 'invalid_field', '"cancel_in_flight" must be a boolean', {
			field: 'cancel_in_flight'
		});
	}
	if (body.cancel_in_flight === true && enabled) {
		throw new ApiFail(
			422,
			'invalid_field',
			'"cancel_in_flight" only applies when disabling automation (send it with "enabled": false)',
			{ field: 'cancel_in_flight' }
		);
	}
	let quota = current.quota;
	if (body.quota !== undefined) {
		quota = validateQuotaPolicy(body.quota);
		await assertRosterStatesExist(db, actor.userId, quota);
	}
	const attemptLimit =
		body.attempt_limit !== undefined
			? validateAttemptLimit(body.attempt_limit)
			: current.attempt_limit;

	// The GitHub PAT: write-only — validated for shape, encrypted, and only
	// a display hint stored beside it. `null` clears; undefined keeps.
	let patEnc: string | null | undefined;
	let patHint: string | null | undefined;
	if (body.github_pat !== undefined) {
		if (body.github_pat === null) {
			patEnc = null;
			patHint = null;
		} else {
			const pat = requireString(body.github_pat, 'github_pat', { max: 500 });
			if (!env.SECRET_ENCRYPTION_KEY) {
				throw new ApiFail(
					500,
					'no_encryption_key',
					'SECRET_ENCRYPTION_KEY is not configured; the GitHub PAT cannot be stored'
				);
			}
			patEnc = await encryptSecret(pat, env.SECRET_ENCRYPTION_KEY);
			patHint = secretHint(pat);
		}
	}

	const changed: string[] = [];
	if (enabled !== current.enabled) changed.push('enabled');
	if (JSON.stringify(quota) !== JSON.stringify(current.quota)) changed.push('quota');
	if (attemptLimit !== current.attempt_limit) changed.push('attempt_limit');
	if (patEnc !== undefined) changed.push('github_pat');

	const now = Date.now();
	if (changed.length > 0 || current.updated_at === null) {
		await runAtomic(env, [
			// Upsert: the row is created lazily on first write, so new users keep
			// the pure defaults (and the off kill switch) without a signup hook.
			db
				.insertInto('supervisor_settings')
				.values({
					user_id: actor.userId,
					enabled: enabled ? 1 : 0,
					quota: JSON.stringify(quota),
					attempt_limit: attemptLimit,
					budget: null,
					pricing: null,
					github_pat_enc: patEnc ?? null,
					github_pat_hint: patHint ?? null,
					updated_at: now
				})
				.onConflict((oc) =>
					oc.column('user_id').doUpdateSet({
						enabled: enabled ? 1 : 0,
						quota: JSON.stringify(quota),
						attempt_limit: attemptLimit,
						// The PAT columns only move when this write replaces/clears them.
						...(patEnc !== undefined
							? { github_pat_enc: patEnc, github_pat_hint: patHint ?? null }
							: {}),
						updated_at: now
					})
				)
				.compile(),
			// Secrets (the PAT included) are elided from this payload by
			// construction: the *fact* of a rotation is in the feed via
			// `changed`, the value never is.
			eventInsert(db, actor, {
				type: 'settings.updated',
				payload: {
					changed,
					enabled,
					quota,
					attempt_limit: attemptLimit
				}
			})
		]);
	}

	// The kill switch turning off behaves like pausing every runner at once:
	// not-yet-acknowledged `assigned` runs are canceled fleet-wide (free —
	// nothing is running yet), while `launching`/`running` runs finish…
	let canceledRuns = 0;
	const switchedOff = current.enabled && !enabled;
	if (switchedOff) {
		canceledRuns += await cancelAssignedRuns(
			db,
			env,
			{ userId: actor.userId },
			'automation disabled',
			now
		);
	}
	// …unless the disable confirmation's bulk-cancel option was taken: plain
	// individual cancels of the in-flight runs, strikes and all — no new
	// semantics (SPEC.md "Pausing a runner").
	if (body.cancel_in_flight === true && !enabled) {
		const inFlight = await db
			.selectFrom('agent_run')
			.select('id')
			.where('user_id', '=', actor.userId)
			.where('status', 'in', [...ACTIVE_RUN_STATUSES])
			.execute();
		for (const run of inFlight) {
			const result = await cancelRun(db, env, actor.userId, run.id);
			if (result.kind === 'canceled') canceledRuns += 1;
		}
	}

	const settings: SupervisorSettingsResponse = await getSupervisorSettings(db, actor.userId);
	if (canceledRuns > 0) settings.canceled_runs = canceledRuns;
	return settings;
}

// ---------------------------------------------------------------------------
// The fleet queue: the Now row (Tines/256)

/** The ref columns the parked and awaiting-human queries select. */
interface QueueRefRow {
	id: string;
	number: number;
	title: string;
	project_name: string;
	entered_at: number;
}

function refOf(row: QueueRefRow, queuePosition: number | null): QueueIssueRef {
	return {
		id: row.id,
		project_name: row.project_name,
		number: row.number,
		title: row.title,
		entered_at: row.entered_at,
		queue_position: queuePosition
	};
}

/**
 * Every eligible issue with no active run, grouped by *why* it is waiting.
 *
 * Computed in one pass over the engine's own loaders — the same five the
 * dispatch pass and the per-issue explainer use — so the board can never
 * disagree with either about who would take an issue or what is blocking it.
 * The grouping verdict comes from `queueVerdict`, which the explainer's own
 * verdict line is built on; a unit test asserts the two agree per issue.
 *
 * Nothing is materialised: this runs on request, on the Agents page load and
 * for `tines supervisor status`.
 */
export async function loadFleetQueue(
	db: Kysely<Database>,
	userId: string,
	now: number = Date.now(),
	options: { project?: string } = {}
): Promise<FleetQueue> {
	const project = options.project ? await resolveProjectRef(db, userId, options.project) : null;
	const [settings, allEligible, runners, rules, counts, parkedRows, humanRow] = await Promise.all([
		loadDispatchSettings(db, userId),
		loadEligibleIssues(db, userId),
		loadEngineRunners(db, userId),
		loadEngineRules(db, userId),
		loadActiveCounts(db, userId),
		// Parked issues are excluded from the eligible set by definition, so
		// they need their own read. Same eligibility joins, `needs_attention`
		// flipped: these are the issues a human has to resume.
		queueRefQuery(db, userId, project?.id).where('issue.needs_attention', '=', 1).execute(),
		// Human stages get a summary line only, so a count and a min suffice.
		db
			.selectFrom('issue')
			.innerJoin('project', 'project.id', 'issue.project_id')
			.innerJoin('workflow_state as st', 'st.id', 'issue.state_id')
			.where('project.user_id', '=', userId)
			.where('project.archived_at', 'is', null)
			.where('st.category', '=', 'awaiting_human')
			.$if(project !== null, (q) => q.where('issue.project_id', '=', project!.id))
			.select((eb) => [
				eb.fn.countAll<number>().as('n'),
				eb.fn.min(sql<number>`COALESCE(issue.state_entered_at, issue.created_at)`).as('oldest')
			])
			.executeTakeFirst()
	]);
	const eligible = project
		? allEligible.filter((issue) => issue.project_id === project.id)
		: allEligible;

	// The queue the explainer reports positions in: eligible issues that would
	// actually route somewhere, oldest-`updated_at` first.
	const positions = new Map<string, number>();
	eligible.filter((c) => isRoutedCandidate(c, rules)).forEach((c, i) => positions.set(c.id, i));

	const groups = new Map<string, QueueGroup>();
	for (const issue of eligible) {
		const { targets, rule, ambiguous, failure, pinned } = targetsForIssue(issue, rules);
		// A target whose runner no longer exists is skipped exactly as the pass
		// and the explainer skip it — that is how a dead pin reaches an empty
		// list and reads as `pin_missing`.
		const resolved: { runner: EngineRunner; verdict: TargetVerdictResult }[] = [];
		for (const target of targets) {
			const runner = runners.get(target.runner_id);
			if (!runner) continue;
			resolved.push({
				runner,
				verdict: targetVerdict(runner, counts, settings.quota, issue.state_id, now)
			});
		}
		const verdict = queueVerdict({
			enabled: settings.enabled,
			parked: false,
			pinned,
			hasRule: rule !== null,
			ambiguous: ambiguous.length > 0,
			targets: resolved.map((r) => r.verdict)
		});
		const speaking = speakingTarget(resolved.map((r) => r.verdict));
		const speakingIndex = speaking ? resolved.findIndex((r) => r.verdict === speaking) : -1;
		const runner = speakingIndex >= 0 ? resolved[speakingIndex].runner : null;

		const ambiguityKey = ambiguous
			.map((r) => r.id)
			.sort()
			.join(',');
		const key = `${issue.state_id}|${verdict}|${runner?.id ?? ''}|${rule?.id ?? ''}|${ambiguityKey}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				state_id: issue.state_id,
				state_name: issue.state_name,
				workflow_id: issue.workflow_id,
				workflow_name: issue.workflow_name,
				verdict,
				detail: groupDetail(verdict, speaking?.detail ?? null, runner?.name ?? null, failure),
				runner_id: runner?.id ?? null,
				runner_name: runner?.name ?? null,
				rule_id: rule?.id ?? null,
				ambiguous_rule_ids: ambiguous.map((r) => r.id),
				binding: bindingFor(verdict, runner, counts, settings.quota, issue.state_id),
				count: 0,
				oldest_entered_at: issue.entered_at,
				issues: []
			};
			groups.set(key, group);
		}
		group.count++;
		group.oldest_entered_at = Math.min(group.oldest_entered_at, issue.entered_at);
		if (group.issues.length < QUEUE_GROUP_REF_LIMIT) {
			group.issues.push(
				refOf({ ...issue, entered_at: issue.entered_at }, positions.get(issue.id) ?? null)
			);
		}
	}

	const parked = parkedRows.map((row) => refOf(row, null));
	return {
		generated_at: now,
		project,
		automation_enabled: settings.enabled,
		quota: settings.quota,
		// Biggest problem first, then whatever has been waiting longest.
		groups: [...groups.values()].sort(
			(a, b) =>
				b.count - a.count ||
				a.oldest_entered_at - b.oldest_entered_at ||
				a.state_name.localeCompare(b.state_name)
		),
		waiting: eligible.length,
		parked: {
			count: parked.length,
			oldest_entered_at: parked[0]?.entered_at ?? null,
			issues: parked.slice(0, QUEUE_GROUP_REF_LIMIT)
		},
		awaiting_human: {
			count: Number(humanRow?.n ?? 0),
			oldest_entered_at: humanRow?.oldest ?? null
		}
	};
}

/** The eligibility joins plus the ref columns, ordered by the wait clock. */
function queueRefQuery(db: Kysely<Database>, userId: string, projectId?: string) {
	let q = db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.innerJoin('workflow_state as st', 'st.id', 'issue.state_id')
		.where('project.user_id', '=', userId)
		.where('project.archived_at', 'is', null)
		.where('st.category', '=', 'active');
	if (projectId) q = q.where('issue.project_id', '=', projectId);
	return q
		.select([
			'issue.id as id',
			'issue.number as number',
			'issue.title as title',
			'project.name as project_name',
			sql<number>`COALESCE(issue.state_entered_at, issue.created_at)`.as('entered_at')
		])
		.orderBy(sql`COALESCE(issue.state_entered_at, issue.created_at)`, 'asc')
		.orderBy('issue.id', 'asc');
}

/**
 * The group's one-line "why". Target verdicts carry their own detail from the
 * same helper the explainer renders; the routing failures have no target to
 * carry one, so they reuse the explainer's wording for the `routed` check.
 */
function groupDetail(
	verdict: QueueVerdict,
	targetDetail: string | null,
	runnerName: string | null,
	routeFailure: ReturnType<typeof targetsForIssue>['failure'] = null
): string {
	switch (verdict) {
		case 'automation_off':
			return 'the kill switch is off — nothing dispatches';
		case 'no_rule':
			return 'no matching routing rule — automation is opt-in via rules';
		case 'ambiguous_rule':
			return 'two routing rules tie — neither is more specific';
		case 'no_targets':
			return routeFailure === 'no_runner_rule'
				? 'no broader rule supplies runners'
				: routeFailure === 'no_targets'
					? 'the effective runner rule has no targets'
					: 'the matching rule has no effective targets';
		case 'pin_missing':
			return 'pinned to a removed runner — clear the pin';
		case 'ok':
			return runnerName ? `would dispatch to ${runnerName} next pass` : 'dispatching next pass';
		default:
			return targetDetail ?? '';
	}
}

/** Which limit binds, so the panel can offer exactly the editor that raises it. */
function bindingFor(
	verdict: QueueVerdict,
	runner: EngineRunner | null,
	counts: ActiveCounts,
	quota: QuotaPolicy,
	stateId: string
): QueueBinding | null {
	if (verdict === 'at_capacity' && runner) {
		return {
			kind: 'max_concurrent',
			runner_id: runner.id,
			runner_name: runner.name,
			current: counts.byRunner.get(runner.id) ?? 0,
			limit: runner.max_concurrent
		};
	}
	if (verdict === 'quota_exhausted') {
		if (quota.type === 'global_cap') {
			return { kind: 'global_cap', current: counts.total, limit: quota.limit };
		}
		return {
			kind: 'state_roster',
			state_id: stateId,
			current: counts.byStartState.get(stateId) ?? 0,
			limit: quotaLimitForState(quota, stateId),
			overridden: stateId in quota.overrides
		};
	}
	return null;
}

// ---------------------------------------------------------------------------
// Stage stats — the "This week" row (Tines/257)

/** Types the visit timeline is built from; anything else cannot open or close a visit. */
const STATS_EVENT_TYPES = ['issue.transitioned', 'issue.created', 'issue.updated'] as const;

/** `1h ≤ window ≤ 90d`; the cap is what bounds the scan. */
export function parseStatsWindow(raw: string | null | undefined): number {
	if (raw === null || raw === undefined || raw === '') return 7 * 24 * 60 * 60 * 1000;
	const match = /^(\d+)(h|d)$/.exec(raw.trim());
	if (!match) {
		throw new ApiFail(422, 'validation_error', '"window" must look like "24h" or "7d"', {
			field: 'window'
		});
	}
	const ms = Number(match[1]) * (match[2] === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
	if (ms < 60 * 60 * 1000 || ms > 90 * 24 * 60 * 60 * 1000) {
		throw new ApiFail(422, 'validation_error', '"window" must be between 1h and 90d', {
			field: 'window'
		});
	}
	return ms;
}

/** A project id or name, for the board's filter chip; 404 when it names nothing. */
export async function resolveProjectRef(
	db: Kysely<Database>,
	userId: string,
	ref: string
): Promise<{ id: string; name: string }> {
	const row = await db
		.selectFrom('project')
		.where('user_id', '=', userId)
		.where((eb) => eb.or([eb('id', '=', ref), eb('name', '=', ref)]))
		.select(['id', 'name'])
		.executeTakeFirst();
	if (!row) throw new ApiFail(404, 'not_found', `No project "${ref}"`);
	return row;
}

/**
 * Per-stage flow over a rolling window, computed on request: two indexed
 * reads feed `computeStageStats`. No rollup table — the PRD's rule is to
 * revisit only if p95 on `/agents` passes a second.
 */
export async function loadStageStats(
	db: Kysely<Database>,
	userId: string,
	query: StatsQuery = {},
	now: number = Date.now()
): Promise<StageStatsReport> {
	const windowMs = parseStatsWindow(query.window);
	if (query.compare !== undefined && query.compare !== 'previous' && query.compare !== 'none') {
		throw new ApiFail(422, 'validation_error', '"compare" must be "previous" or "none"', {
			field: 'compare'
		});
	}
	const compare = query.compare !== 'none';
	const project = query.project ? await resolveProjectRef(db, userId, query.project) : null;
	// Both windows are scanned in one pass; `compare=none` still reads them,
	// which keeps the query plan (and the cache) identical.
	const scanFrom = now - 2 * windowMs;

	const [stateRows, eventRows, runRows, outcomeRow, markerRows] = await Promise.all([
		db
			.selectFrom('workflow_state as st')
			.innerJoin('workflow as wf', 'wf.id', 'st.workflow_id')
			.where('wf.user_id', '=', userId)
			.select([
				'st.id as id',
				'st.name as name',
				'st.category as category',
				'st.position as position',
				'wf.id as workflow_id',
				'wf.name as workflow_name'
			])
			.execute(),
		(() => {
			let q = db
				.selectFrom('event')
				.leftJoin('api_key', 'api_key.id', 'event.actor_api_key_id')
				.where('event.user_id', '=', userId)
				// A deleted issue's events keep a NULL issue_id (ON DELETE SET
				// NULL); grouping them by issue would merge every such issue
				// into one timeline.
				.where('event.issue_id', 'is not', null)
				.select([
					'event.id as id',
					'event.type as type',
					'event.issue_id as issue_id',
					'event.payload as payload',
					'event.created_at as created_at',
					'event.actor_api_key_id as actor_api_key_id',
					sql<number>`CASE WHEN api_key.agent_run_id IS NOT NULL THEN 1 ELSE 0 END`.as(
						'actor_is_run'
					)
				]);
			q = applyEventWindow(q, { since: scanFrom, until: now, type: [...STATS_EVENT_TYPES] });
			if (project) q = q.where('event.project_id', '=', project.id);
			return q.orderBy('event.created_at').orderBy('event.id').execute();
		})(),
		(() => {
			let q = db
				.selectFrom('agent_run')
				.innerJoin('runner', 'runner.id', 'agent_run.runner_id')
				.innerJoin('issue', 'issue.id', 'agent_run.issue_id')
				.where('agent_run.user_id', '=', userId)
				.where('agent_run.created_at', '>=', scanFrom)
				.select([
					'agent_run.id as id',
					'agent_run.issue_id as issue_id',
					'agent_run.runner_id as runner_id',
					'runner.name as runner_name',
					'agent_run.status as status',
					'agent_run.outcome as outcome',
					'agent_run.state_id_at_start as state_id_at_start',
					'agent_run.api_key_id as api_key_id',
					'agent_run.created_at as created_at',
					'agent_run.started_at as started_at',
					'agent_run.ended_at as ended_at'
				]);
			if (project) q = q.where('issue.project_id', '=', project.id);
			return q.execute();
		})(),
		db
			.selectFrom('agent_run')
			.where('user_id', '=', userId)
			.where('outcome', 'is not', null)
			.select((eb) => eb.fn.min<number | null>('ended_at').as('since'))
			.executeTakeFirst(),
		(() => {
			let q = db
				.selectFrom('event')
				.select([
					'id',
					'type',
					'payload',
					'project_id',
					'created_at',
					'actor_api_key_id',
					'actor_user_id'
				])
				.where('user_id', '=', userId)
				.where('created_at', '>=', now - windowMs)
				.where('created_at', '<', now)
				.where('type', 'in', [
					'context.created',
					'context.updated',
					'context.deleted',
					'settings.updated',
					'runner.updated',
					'routing_rule.created',
					'routing_rule.updated',
					'routing_rule.deleted'
				])
				.orderBy('created_at');
			if (project) {
				q = q.where((eb) =>
					eb.or([eb('project_id', 'is', null), eb('project_id', '=', project.id)])
				);
			}
			return q.execute();
		})()
	]);

	const events: StatsEvent[] = [];
	const advancedByKey = new Set<string>();
	for (const row of eventRows) {
		const payload = JSON.parse(row.payload) as Record<string, unknown>;
		const type = row.type as (typeof STATS_EVENT_TYPES)[number];
		let toStateId: string | null = null;
		let fromStateId: string | null = null;
		if (type === 'issue.transitioned') {
			fromStateId = (payload.from_state_id as string | undefined) ?? null;
			toStateId = (payload.to_state_id as string | undefined) ?? null;
			if (row.actor_api_key_id) advancedByKey.add(row.actor_api_key_id);
		} else if (type === 'issue.created') {
			toStateId = (payload.state_id as string | undefined) ?? null;
		} else {
			// A workflow change moves the issue but emits `issue.updated`; the
			// state ids are only on rows written since Tines/257. Resolve older
			// payloads by the state names within the named workflows.
			if (!payload.workflow_to_id) continue;
			const resolveNamedState = (workflowId: unknown, stateName: unknown) =>
				typeof workflowId === 'string' && typeof stateName === 'string'
					? (stateRows.find((state) => state.workflow_id === workflowId && state.name === stateName)
							?.id ?? null)
					: null;
			fromStateId =
				(payload.from_state_id as string | undefined) ??
				resolveNamedState(payload.workflow_from_id, payload.from_state_name);
			toStateId =
				(payload.to_state_id as string | undefined) ??
				resolveNamedState(payload.workflow_to_id, payload.to_state_name);
			if (!toStateId) continue;
		}
		if (!toStateId && !fromStateId) continue;
		events.push({
			id: row.id,
			type,
			issue_id: row.issue_id as string,
			created_at: row.created_at,
			actor_api_key_id: row.actor_api_key_id,
			actor_is_run: row.actor_is_run === 1,
			from_state_id: fromStateId,
			to_state_id: toStateId
		});
	}

	const states = stateRows.map((s) => ({
		id: s.id,
		name: s.name,
		workflow_id: s.workflow_id,
		workflow_name: s.workflow_name,
		category: s.category,
		position: s.position
	}));
	const runs = runRows.map((r) => ({
		...r,
		outcome: (r.outcome as RunEndOutcome | null) ?? null
	}));
	const baseInput = {
		now,
		windowMs,
		compare,
		states,
		events,
		runs,
		advancedByKey,
		outcomeRecordedSince: outcomeRow?.since ?? null,
		project
	};
	const report = computeStageStats(baseInput);

	type MarkerSeed = Omit<ChangeMarker, 'effects'> & { actor: string };
	const seeds: MarkerSeed[] = [];
	for (const row of markerRows) {
		const payload = JSON.parse(row.payload) as Record<string, any>;
		let kind: ChangeMarker['kind'] | null = null;
		let label = '';
		let stateIds: string[] = [];
		if (row.type.startsWith('context.')) {
			const scope = payload.scope ?? payload.scope_to;
			if (payload.kind !== 'prompt' || payload.name === 'journal' || !scope?.workflow_state_id)
				continue;
			kind = 'prompt';
			stateIds = [scope.workflow_state_id];
			const meta = states.find((state) => state.id === scope.workflow_state_id);
			label = `Stage prompt edited${meta ? `: ${meta.workflow_name}/${meta.name}` : ''}`;
		} else if (row.type === 'settings.updated') {
			const changed = Array.isArray(payload.changed) ? payload.changed : [];
			if (changed.includes('quota')) {
				kind = 'quota';
				label = 'Supervisor quota changed';
			} else if (changed.includes('enabled')) {
				kind = 'automation';
				label = 'Automation setting changed';
			}
		} else if (row.type === 'runner.updated') {
			if (
				!(payload.changed as unknown[] | undefined)?.includes('max_concurrent') ||
				payload.reconnected
			)
				continue;
			kind = 'runner_cap';
			label = `Runner cap changed${payload.name ? `: ${payload.name}` : ''}`;
		} else if (row.type.startsWith('routing_rule.')) {
			kind = 'rule';
			if (typeof payload.workflow_state_id === 'string') {
				stateIds = [payload.workflow_state_id];
			}
			const scope = stateIds.length > 0 ? 'Stage' : row.project_id ? 'Project' : 'Global';
			label = `${scope} routing rule changed`;
		}
		if (!kind) continue;
		const actor = row.actor_api_key_id ?? row.actor_user_id;
		const previous = seeds.at(-1);
		if (
			previous &&
			previous.kind === kind &&
			previous.actor === actor &&
			row.created_at - previous.at <= 60_000
		) {
			previous.event_ids.push(row.id);
			previous.state_ids = [...new Set([...previous.state_ids, ...stateIds])];
			continue;
		}
		seeds.push({
			id: row.id,
			at: row.created_at,
			kind,
			label,
			event_ids: [row.id],
			state_ids: stateIds,
			actor
		});
	}
	const figures = (subReport: StageStatsReport, stateId: string) => {
		const row = subReport.states.find((stage) => stage.state_id === stateId)?.current;
		return row
			? {
					visits: row.visits,
					exits: row.exits,
					sent_back_share: row.sent_back.share,
					queue_wait_p50: row.queue_wait?.p50 ?? null
				}
			: null;
	};
	report.markers = seeds
		.slice(-20)
		.reverse()
		.map((seed) => {
			const before = computeStageStats({
				...baseInput,
				now: seed.at,
				windowMs: Math.max(1, seed.at - report.window.since),
				compare: false
			});
			const after = computeStageStats({
				...baseInput,
				now,
				windowMs: Math.max(1, now - seed.at),
				compare: false
			});
			const affected =
				seed.state_ids.length > 0 ? seed.state_ids : report.states.map((stage) => stage.state_id);
			return {
				...seed,
				effects: affected.map((stateId) => ({
					state_id: stateId,
					before: figures(before, stateId),
					after: figures(after, stateId)
				}))
			};
		});
	return report;
}

/** The issue, actor, comment and prompt-version evidence behind sent-back. */
export async function loadSentBackDrilldown(
	db: Kysely<Database>,
	userId: string,
	query: { state: string; window?: string; project?: string; until?: number },
	now: number = Date.now()
): Promise<SentBackDrilldown> {
	const windowMs = parseStatsWindow(query.window);
	if (query.until !== undefined) {
		if (!Number.isSafeInteger(query.until) || query.until < 0 || query.until > now)
			throw new ApiFail(
				422,
				'validation_error',
				'until must be a nonfuture epoch millisecond integer'
			);
		now = query.until;
	}
	const since = now - windowMs;
	const project = query.project ? await resolveProjectRef(db, userId, query.project) : null;
	const states = await db
		.selectFrom('workflow_state as st')
		.innerJoin('workflow as wf', 'wf.id', 'st.workflow_id')
		.where((eb) => eb.or([eb('wf.user_id', '=', userId), eb('wf.user_id', 'is', null)]))
		.select([
			'st.id',
			'st.name',
			'st.position',
			'st.category',
			'st.workflow_id',
			'wf.name as workflow_name'
		])
		.execute();
	const state = states.find((row) => row.id === query.state);
	if (!state) throw new ApiFail(404, 'not_found', `No workflow state "${query.state}"`);
	const stateById = new Map(states.map((row) => [row.id, row]));

	let transitions = applyEventWindow(eventQuery(db, userId), {
		since,
		until: now,
		type: 'issue.transitioned',
		state: query.state
	});
	transitions = transitions.where(
		sql<string>`json_extract(event.payload, '$.from_state_id')`,
		'=',
		query.state
	);
	if (project) transitions = transitions.where('event.project_id', '=', project.id);
	const events = (await transitions.orderBy('event.created_at desc').execute()).map(serializeEvent);
	const sent = events.filter((event) => {
		const target = stateById.get(String(event.payload.to_state_id ?? ''));
		return (
			target?.workflow_id === state.workflow_id &&
			target.category !== 'done' &&
			target.position < state.position
		);
	});

	const issueIds = [
		...new Set(sent.map((event) => event.issue_id).filter((id): id is string => id !== null))
	];
	const comments = issueIds.length
		? await db
				.selectFrom('comment')
				.selectAll()
				.where('issue_id', 'in', issueIds)
				.orderBy('created_at')
				.execute()
		: [];
	const prompt = await db
		.selectFrom('context_item')
		.select(['id', 'name', 'version'])
		.where('user_id', '=', userId)
		.where('kind', '=', 'prompt')
		.where('name', '=', 'instructions')
		.where('workflow_state_id', '=', state.id)
		.executeTakeFirst();
	// Resolve prompt generations from their lifecycle events, not from the
	// currently-live row: delete/recreate gives the replacement a new id.
	const promptEvents = await db
		.selectFrom('event')
		.select(['type', 'payload', 'created_at'])
		.where('user_id', '=', userId)
		.where('type', 'in', ['context.created', 'context.updated', 'context.deleted'])
		.orderBy('created_at')
		.orderBy('id')
		.execute();
	type PromptGeneration = {
		id: string;
		created_at: number;
		deleted_at: number | null;
		updates: { at: number; version: number | null }[];
	};
	const generations = new Map<string, PromptGeneration>();
	for (const event of promptEvents) {
		const payload = JSON.parse(event.payload) as Record<string, any>;
		const id = typeof payload.context_id === 'string' ? payload.context_id : null;
		if (!id) continue;
		const scope = payload.scope_to ?? payload.scope;
		const relevant =
			payload.kind === 'prompt' &&
			payload.name === 'instructions' &&
			scope?.workflow_state_id === state.id;
		if (event.type === 'context.created' && relevant) {
			generations.set(id, { id, created_at: event.created_at, deleted_at: null, updates: [] });
			continue;
		}
		const generation = generations.get(id);
		if (!generation) continue;
		if (event.type === 'context.deleted') generation.deleted_at = event.created_at;
		else if (event.type === 'context.updated') {
			generation.updates.push({
				at: event.created_at,
				version: Number.isFinite(Number(payload.version)) ? Number(payload.version) : null
			});
		}
	}
	// Old fixtures/data may predate context.created events. The current row is
	// still a valid generation, with its version countable backwards.
	if (prompt && !generations.has(prompt.id)) {
		generations.set(prompt.id, {
			id: prompt.id,
			created_at: 0,
			deleted_at: null,
			updates: promptEvents
				.filter((event) => {
					const payload = JSON.parse(event.payload) as Record<string, unknown>;
					return event.type === 'context.updated' && payload.context_id === prompt.id;
				})
				.map((event) => {
					const version = Number((JSON.parse(event.payload) as Record<string, unknown>).version);
					return { at: event.created_at, version: Number.isFinite(version) ? version : null };
				})
		});
	}
	const promptAt = (at: number) => {
		const generation = [...generations.values()]
			.filter((item) => item.created_at <= at && (item.deleted_at === null || item.deleted_at > at))
			.at(-1);
		if (!generation) return { prompt_context_id: null, prompt_version: null };
		const updates = generation.updates.filter((event) => event.at <= at);
		return {
			prompt_context_id: generation.id,
			prompt_version:
				updates
					.map((event) => event.version)
					.filter((v): v is number => v !== null)
					.at(-1) ?? 1 + updates.length
		};
	};

	return {
		state: {
			id: state.id,
			name: state.name,
			workflow_id: state.workflow_id,
			workflow_name: state.workflow_name
		},
		window: { since, until: now },
		prompt: prompt
			? {
					context_id: prompt.id,
					name: prompt.name,
					current_version: prompt.version,
					edit_url: `/workflows/${state.workflow_id}?state=${state.id}#state-${state.id}`
				}
			: null,
		items: sent.flatMap((event) => {
			if (!event.issue_id || !event.issue_ref) return [];
			const candidates = comments.filter(
				(comment) => comment.issue_id === event.issue_id && comment.created_at <= event.created_at
			);
			const authored = candidates.filter((comment) =>
				event.actor.api_key_id
					? comment.actor_api_key_id === event.actor.api_key_id
					: comment.actor_user_id === event.actor.user_id && comment.actor_api_key_id === null
			);
			const comment = authored.at(-1) ?? candidates.at(-1) ?? null;
			const targetId = String(event.payload.to_state_id);
			return [
				{
					issue: { id: event.issue_id, ...event.issue_ref },
					transitioned_at: event.created_at,
					to_state_id: targetId,
					to_state_name:
						stateById.get(targetId)?.name ?? String(event.payload.to_state_name ?? targetId),
					action: typeof event.payload.action === 'string' ? event.payload.action : null,
					actor: event.actor,
					comment: comment
						? {
								id: comment.id,
								excerpt: comment.body.slice(0, 280),
								created_at: comment.created_at
							}
						: null,
					...promptAt(event.created_at)
				}
			];
		})
	};
}
