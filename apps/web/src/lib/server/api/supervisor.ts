import {
	ACTIVE_RUN_STATUSES,
	type QuotaPolicy,
	type SupervisorSettings,
	type SupervisorSettingsResponse,
	type UpdateSupervisorSettingsRequest
} from '@tines/shared';
import type { Kysely } from 'kysely';
import { encryptSecret, secretHint } from '$lib/server/crypto';
import type { Database } from '$lib/server/db';
import { cancelAssignedRuns, cancelRun } from '$lib/server/supervisor/engine';
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
		if (typeof quota.limit !== 'number' || !Number.isInteger(quota.limit) || quota.limit < 1 || quota.limit > 100) {
			throw fail('"quota.limit" must be an integer between 1 and 100');
		}
		return { type: 'global_cap', limit: quota.limit };
	}
	if (quota.type === 'state_roster') {
		const extra = Object.keys(quota).filter((k) => !['type', 'default_limit', 'overrides'].includes(k));
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
		throw new ApiFail(422, 'invalid_field', '"attempt_limit" must be an integer between 1 and 100', {
			field: 'attempt_limit'
		});
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
		body.attempt_limit !== undefined ? validateAttemptLimit(body.attempt_limit) : current.attempt_limit;

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
						...(patEnc !== undefined ? { github_pat_enc: patEnc, github_pat_hint: patHint ?? null } : {}),
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
