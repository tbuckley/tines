import {
	ACTIVE_RUN_STATUSES,
	QUEUE_GROUP_REF_LIMIT,
	type FleetQueue,
	type QueueBinding,
	type QueueGroup,
	type QueueIssueRef,
	type QueueVerdict,
	type QuotaPolicy,
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
import { ApiFail, requireString, runAtomic, type ActorContext } from './core';
import { eventInsert } from './events';

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
	now: number = Date.now()
): Promise<FleetQueue> {
	const [settings, eligible, runners, rules, counts, parkedRows, humanRow] = await Promise.all([
		loadDispatchSettings(db, userId),
		loadEligibleIssues(db, userId),
		loadEngineRunners(db, userId),
		loadEngineRules(db, userId),
		loadActiveCounts(db, userId),
		// Parked issues are excluded from the eligible set by definition, so
		// they need their own read. Same eligibility joins, `needs_attention`
		// flipped: these are the issues a human has to resume.
		queueRefQuery(db, userId).where('issue.needs_attention', '=', 1).execute(),
		// Human stages get a summary line only, so a count and a min suffice.
		db
			.selectFrom('issue')
			.innerJoin('project', 'project.id', 'issue.project_id')
			.innerJoin('workflow_state as st', 'st.id', 'issue.state_id')
			.where('project.user_id', '=', userId)
			.where('project.archived_at', 'is', null)
			.where('st.category', '=', 'awaiting_human')
			.select((eb) => [
				eb.fn.countAll<number>().as('n'),
				eb.fn.min(sql<number>`COALESCE(issue.state_entered_at, issue.created_at)`).as('oldest')
			])
			.executeTakeFirst()
	]);

	// The queue the explainer reports positions in: eligible issues that would
	// actually route somewhere, oldest-`updated_at` first.
	const positions = new Map<string, number>();
	eligible.filter((c) => isRoutedCandidate(c, rules)).forEach((c, i) => positions.set(c.id, i));

	const groups = new Map<string, QueueGroup>();
	for (const issue of eligible) {
		const { targets, rule, ambiguous, pinned } = targetsForIssue(issue, rules);
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

		const key = `${issue.state_id}|${verdict}|${runner?.id ?? ''}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				state_id: issue.state_id,
				state_name: issue.state_name,
				workflow_id: issue.workflow_id,
				workflow_name: issue.workflow_name,
				verdict,
				detail: groupDetail(verdict, speaking?.detail ?? null, runner?.name ?? null),
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
function queueRefQuery(db: Kysely<Database>, userId: string) {
	return db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.innerJoin('workflow_state as st', 'st.id', 'issue.state_id')
		.where('project.user_id', '=', userId)
		.where('project.archived_at', 'is', null)
		.where('st.category', '=', 'active')
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
	runnerName: string | null
): string {
	switch (verdict) {
		case 'automation_off':
			return 'the kill switch is off — nothing dispatches';
		case 'no_rule':
			return 'no matching routing rule — automation is opt-in via rules';
		case 'ambiguous_rule':
			return 'two routing rules tie — neither is more specific';
		case 'no_targets':
			return 'the matching rule has no targets';
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
