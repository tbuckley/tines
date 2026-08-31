import {
	ACTIVE_RUN_STATUSES,
	DEFAULT_MANAGED_RUN_COST_USD,
	MODEL_TIERS,
	RUNNER_ONLINE_WINDOW_MS,
	RUNNER_TYPES,
	type CreateRunnerRequest,
	type ModelTier,
	type RegisterRunnerRequest,
	type Runner,
	type RunnerBudget,
	type RunnerStatus,
	type RunnerTierOverrides,
	type RunnerTokenResponse,
	type RunnerType,
	type RoutingTarget,
	type UpdateRunnerRequest
} from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { encryptSecret, sha256Hex } from '$lib/server/crypto';
import { deleteRunLogObjects } from '$lib/server/supervisor/run-log';
import { newId, randomString, type Database } from '$lib/server/db';
import { pingAnthropicKey } from '$lib/server/supervisor/claude-adapter';
import { cancelAssignedRuns } from '$lib/server/supervisor/engine';
import { builtinTierModels } from '$lib/server/supervisor/logic';
import { ApiFail, notFound, optionalString, requireString, runAtomic, type ActorContext } from './core';
import { eventInsert } from './events';
import { scopeLabel } from './scope';

/**
 * Provider-key ping, injectable for tests (the default reaches the live
 * Anthropic API). Returns null when the key works, else the failure text.
 */
export type ProviderKeyPing = (type: RunnerType, apiKey: string) => Promise<string | null>;

const defaultPing: ProviderKeyPing = (type, apiKey) =>
	type === 'claude_managed' ? pingAnthropicKey(apiKey) : Promise.resolve('unsupported runner type');

// ---------------------------------------------------------------------------
// Validation

export function requireTier(value: unknown, field: string): ModelTier {
	if (typeof value !== 'string' || !(MODEL_TIERS as readonly string[]).includes(value)) {
		throw new ApiFail(
			422,
			'unknown_tier',
			`Unknown tier ${JSON.stringify(value)}; the tier set is closed: ${MODEL_TIERS.join(', ')}`,
			{ field, allowed_tiers: [...MODEL_TIERS] }
		);
	}
	return value as ModelTier;
}

/** Names double as CLI addresses and routing-rule targets: no whitespace, ":", or "/". */
const RUNNER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function validateRunnerName(value: unknown): string {
	const name = requireString(value, 'name', { max: 100 }).trim();
	if (!RUNNER_NAME_PATTERN.test(name)) {
		throw new ApiFail(
			422,
			'invalid_field',
			`Runner names are CLI addresses, so they must match ${RUNNER_NAME_PATTERN} (got "${name}")`,
			{ field: 'name' }
		);
	}
	return name;
}

export function validateBoundedInt(value: unknown, field: string, min: number, max: number): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
		throw new ApiFail(422, 'invalid_field', `"${field}" must be an integer between ${min} and ${max}`, {
			field
		});
	}
	return value;
}

const LOCAL_HARNESSES = ['claude_code', 'codex', 'custom'] as const;

/**
 * Non-secret config for a local runner. Strict by design: unknown keys are
 * rejected, and a `command` template only makes sense with the custom harness.
 */
function validateLocalConfig(value: unknown): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new ApiFail(422, 'invalid_field', '"config" must be an object', { field: 'config' });
	}
	const config = value as Record<string, unknown>;
	const allowed = ['harness', 'command', 'hostname', 'platform'];
	const unknown = Object.keys(config).filter((k) => !allowed.includes(k));
	if (unknown.length > 0) {
		throw new ApiFail(
			422,
			'invalid_field',
			`Unknown config key${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => `"${k}"`).join(', ')}; a local runner's config takes: ${allowed.join(', ')}`,
			{ field: 'config', rejected_fields: unknown }
		);
	}
	const harness = config.harness ?? 'claude_code';
	if (typeof harness !== 'string' || !(LOCAL_HARNESSES as readonly string[]).includes(harness)) {
		throw new ApiFail(
			422,
			'invalid_field',
			`"config.harness" must be one of: ${LOCAL_HARNESSES.join(', ')}`,
			{ field: 'config' }
		);
	}
	const out: Record<string, unknown> = { harness };
	if (config.command !== undefined) {
		if (harness !== 'custom') {
			throw new ApiFail(422, 'invalid_field', '"config.command" only applies to the custom harness', {
				field: 'config'
			});
		}
		out.command = requireString(config.command, 'config.command', { max: 1000 });
	} else if (harness === 'custom') {
		throw new ApiFail(422, 'invalid_field', 'The custom harness needs a "config.command" template', {
			field: 'config'
		});
	}
	// Device display info, reported by the daemon at registration.
	const hostname = optionalString(config.hostname, 'config.hostname', { max: 200 });
	if (hostname !== undefined) out.hostname = hostname;
	const platform = optionalString(config.platform, 'config.platform', { max: 200 });
	if (platform !== undefined) out.platform = platform;
	return out;
}

/**
 * Per-tier model overrides: `{ "<tier>": { "model": …, "effort"?: … } }`.
 * A tier may also be a bare model-id string (the CLI's `--set tier=model`
 * sugar normalizes to the object form). Returns null for "no overrides".
 */
export function validateTierOverrides(value: unknown): RunnerTierOverrides | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new ApiFail(422, 'invalid_field', '"tiers" must map tiers to model overrides', {
			field: 'tiers'
		});
	}
	const out: RunnerTierOverrides = {};
	for (const [tier, override] of Object.entries(value as Record<string, unknown>)) {
		requireTier(tier, 'tiers');
		const raw = typeof override === 'string' ? { model: override } : override;
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
			throw new ApiFail(422, 'invalid_field', `"tiers.${tier}" must be a model id or { model, effort? }`, {
				field: `tiers.${tier}`
			});
		}
		const rec = raw as Record<string, unknown>;
		const unknown = Object.keys(rec).filter((k) => !['model', 'effort'].includes(k));
		if (unknown.length > 0) {
			throw new ApiFail(
				422,
				'invalid_field',
				`Unknown tier-override key${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => `"${k}"`).join(', ')}; a tier override takes: model, effort`,
				{ field: `tiers.${tier}`, rejected_fields: unknown }
			);
		}
		const model = requireString(rec.model, `tiers.${tier}.model`, { max: 200 });
		const effort = optionalString(rec.effort, `tiers.${tier}.effort`, { max: 50 });
		const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
		if (effort !== undefined && !efforts.includes(effort)) {
			throw new ApiFail(
				422,
				'invalid_field',
				`"tiers.${tier}.effort" must be one of: ${efforts.join(', ')}`,
				{ field: `tiers.${tier}.effort` }
			);
		}
		out[tier as ModelTier] = { model, ...(effort !== undefined ? { effort } : {}) };
	}
	return Object.keys(out).length > 0 ? out : null;
}

const BUDGET_FIELDS = ['daily_usd', 'daily_tokens', 'max_run_cost_usd', 'max_run_tokens'] as const;

/**
 * Per-runner money limits. The per-run caps are enforced now (Claude's
 * session budget; the token cap at poll time); the daily fields are stored
 * for the budgets milestone. Returns null for "no limits".
 */
export function validateRunnerBudget(value: unknown): RunnerBudget | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new ApiFail(422, 'invalid_field', '"budget" must be an object', { field: 'budget' });
	}
	const raw = value as Record<string, unknown>;
	const unknown = Object.keys(raw).filter((k) => !(BUDGET_FIELDS as readonly string[]).includes(k));
	if (unknown.length > 0) {
		throw new ApiFail(
			422,
			'invalid_field',
			`Unknown budget field${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => `"${k}"`).join(', ')}; a runner budget takes: ${BUDGET_FIELDS.join(', ')}`,
			{ field: 'budget', rejected_fields: unknown }
		);
	}
	const out: RunnerBudget = {};
	for (const field of BUDGET_FIELDS) {
		const v = raw[field];
		if (v === undefined) continue;
		const wholeTokens = field === 'daily_tokens' || field === 'max_run_tokens';
		if (
			typeof v !== 'number' ||
			!Number.isFinite(v) ||
			v <= 0 ||
			(wholeTokens && !Number.isInteger(v))
		) {
			throw new ApiFail(
				422,
				'invalid_field',
				`"budget.${field}" must be a positive ${wholeTokens ? 'integer' : 'number'}`,
				{ field: `budget.${field}` }
			);
		}
		out[field] = v;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** Managed types: validate the pasted provider key with a ping, then encrypt. */
async function validatedProviderKey(
	env: Env,
	type: RunnerType,
	value: unknown,
	ping: ProviderKeyPing
): Promise<string> {
	const apiKey = requireString(value, 'api_key', { max: 500 });
	const failure = await ping(type, apiKey);
	if (failure) {
		throw new ApiFail(422, 'invalid_api_key', failure, { field: 'api_key' });
	}
	if (!env.SECRET_ENCRYPTION_KEY) {
		throw new ApiFail(
			500,
			'no_encryption_key',
			'SECRET_ENCRYPTION_KEY is not configured; managed runner credentials cannot be stored'
		);
	}
	return encryptSecret(apiKey, env.SECRET_ENCRYPTION_KEY);
}

// ---------------------------------------------------------------------------
// Loading

export function runnerQuery(db: Kysely<Database>, userId: string) {
	return db
		.selectFrom('runner')
		.selectAll('runner')
		.select((eb) =>
			eb
				.selectFrom('agent_run')
				.whereRef('agent_run.runner_id', '=', 'runner.id')
				.where('agent_run.status', 'in', [...ACTIVE_RUN_STATUSES])
				.select((eb2) => eb2.fn.countAll<number>().as('n'))
				.as('active_runs')
		)
		.where('runner.user_id', '=', userId);
}

type RunnerRow = Awaited<ReturnType<ReturnType<typeof runnerQuery>['execute']>>[number];

/** Managed runners are always online; local ones while the daemon polls. */
export function runnerOnline(
	runner: { type: string; last_seen_at: number | null },
	now = Date.now()
): boolean {
	if (runner.type !== 'local') return true;
	return runner.last_seen_at !== null && now - runner.last_seen_at <= RUNNER_ONLINE_WINDOW_MS;
}

function serializeRunner(row: RunnerRow, now = Date.now()): Runner {
	let config: Record<string, unknown> = {};
	try {
		config = JSON.parse(row.config) as Record<string, unknown>;
	} catch {
		// An unreadable config column renders as empty rather than 500ing.
	}
	let tiers: RunnerTierOverrides | null = null;
	try {
		tiers = row.tiers ? (JSON.parse(row.tiers) as RunnerTierOverrides) : null;
	} catch {
		// Unreadable overrides render as "all built-ins".
	}
	let budget: RunnerBudget | null = null;
	try {
		budget = row.budget ? (JSON.parse(row.budget) as RunnerBudget) : null;
	} catch {
		// An unreadable budget renders as "no limits" (and enforces nothing).
	}
	return {
		id: row.id,
		type: row.type as RunnerType,
		name: row.name,
		status: row.status as RunnerStatus,
		max_concurrent: row.max_concurrent,
		max_run_minutes: row.max_run_minutes,
		default_tier: row.default_tier as ModelTier,
		tiers,
		tier_models: builtinTierModels(row),
		budget,
		has_api_key: row.secret_enc !== null,
		config,
		online: runnerOnline(row, now),
		last_seen_at: row.last_seen_at,
		launch_failures: row.launch_failures,
		backoff_until: row.backoff_until,
		active_runs: Number(row.active_runs ?? 0),
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

export async function listRunners(db: Kysely<Database>, userId: string): Promise<Runner[]> {
	const rows = await runnerQuery(db, userId).orderBy('runner.created_at asc').orderBy('runner.id asc').execute();
	const now = Date.now();
	return rows.map((r) => serializeRunner(r, now));
}

export async function getRunner(db: Kysely<Database>, userId: string, id: string): Promise<Runner> {
	const row = await runnerQuery(db, userId).where('runner.id', '=', id).executeTakeFirst();
	if (!row) throw notFound();
	return serializeRunner(row);
}

async function assertRunnerNameAvailable(
	db: Kysely<Database>,
	userId: string,
	name: string,
	excludeId?: string
) {
	let q = db.selectFrom('runner').select('id').where('user_id', '=', userId).where('name', '=', name);
	if (excludeId) q = q.where('id', '!=', excludeId);
	const existing = await q.executeTakeFirst();
	if (existing) {
		throw new ApiFail(
			422,
			'duplicate_runner_name',
			`A runner named "${name}" already exists; routing rules and the CLI address runners by name, so names are unique`,
			{ field: 'name', existing_runner_id: existing.id }
		);
	}
}

// ---------------------------------------------------------------------------
// Mutations

export async function createRunner(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	body: CreateRunnerRequest,
	ping: ProviderKeyPing = defaultPing
): Promise<Runner> {
	if (typeof body.type !== 'string' || !(RUNNER_TYPES as readonly string[]).includes(body.type)) {
		throw new ApiFail(
			422,
			'unknown_runner_type',
			`Unknown runner type ${JSON.stringify(body.type)}; allowed: ${RUNNER_TYPES.join(', ')}`,
			{ field: 'type', allowed_types: [...RUNNER_TYPES] }
		);
	}
	// Gemini's credential handling (per-launch passing, egress transforms)
	// arrives with its milestone.
	if (body.type === 'gemini_managed') {
		throw new ApiFail(
			422,
			'managed_runner_unavailable',
			'"gemini_managed" runners arrive in a later milestone; "local" and "claude_managed" runners can be created today',
			{ field: 'type' }
		);
	}
	const managed = body.type !== 'local';

	const name = validateRunnerName(body.name);
	await assertRunnerNameAvailable(db, actor.userId, name);
	const maxConcurrent =
		body.max_concurrent === undefined
			? managed
				? 3
				: 1
			: validateBoundedInt(body.max_concurrent, 'max_concurrent', 1, 100);
	const maxRunMinutes =
		body.max_run_minutes === undefined
			? 30
			: validateBoundedInt(body.max_run_minutes, 'max_run_minutes', 1, 24 * 60);
	const defaultTier = body.default_tier === undefined ? 'balanced' : requireTier(body.default_tier, 'default_tier');
	const tiers = validateTierOverrides(body.tiers);

	let config: Record<string, unknown>;
	let secretEnc: string | null = null;
	let budget: RunnerBudget | null;
	if (managed) {
		// A managed runner's config is Tines-managed (provisioned agent ids,
		// the environment id) — it is not user input.
		if (body.config !== undefined && Object.keys(body.config).length > 0) {
			throw new ApiFail(
				422,
				'invalid_field',
				'Managed runners have no user-editable "config"; the key goes in "api_key" and limits in "budget"',
				{ field: 'config' }
			);
		}
		config = {};
		if (body.api_key === undefined) {
			throw new ApiFail(422, 'invalid_field', `A ${body.type} runner needs an "api_key"`, {
				field: 'api_key'
			});
		}
		secretEnc = await validatedProviderKey(env, body.type, body.api_key, ping);
		// The $5 default per-run cap keeps real dollars bounded out of the box;
		// an explicit budget (including `{}` = uncapped) replaces it wholesale.
		budget =
			body.budget === undefined
				? { max_run_cost_usd: DEFAULT_MANAGED_RUN_COST_USD }
				: validateRunnerBudget(body.budget);
	} else {
		if (body.api_key !== undefined) {
			throw new ApiFail(422, 'invalid_field', 'Local runners take no "api_key"', { field: 'api_key' });
		}
		config = validateLocalConfig(body.config);
		budget = body.budget === undefined ? null : validateRunnerBudget(body.budget);
	}

	const now = Date.now();
	// 'rnr' leaves the `run_` prefix free for agent_run ids.
	const id = newId('rnr');
	await runAtomic(env, [
		db
			.insertInto('runner')
			.values({
				id,
				user_id: actor.userId,
				type: body.type,
				name,
				status: 'active',
				max_concurrent: maxConcurrent,
				max_run_minutes: maxRunMinutes,
				default_tier: defaultTier,
				tiers: tiers ? JSON.stringify(tiers) : null,
				budget: budget ? JSON.stringify(budget) : null,
				config: JSON.stringify(config),
				secret_enc: secretEnc,
				runner_token_hash: null,
				last_seen_at: null,
				launch_failures: 0,
				backoff_until: null,
				created_at: now,
				updated_at: now
			})
			.compile(),
		// The key itself is elided by construction — only its presence is on record.
		eventInsert(db, actor, {
			type: 'runner.registered',
			payload: { runner_id: id, name, runner_type: body.type }
		})
	]);
	return getRunner(db, actor.userId, id);
}

export async function updateRunner(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	body: UpdateRunnerRequest,
	ping: ProviderKeyPing = defaultPing
): Promise<Runner> {
	const row = await runnerQuery(db, actor.userId).where('runner.id', '=', id).executeTakeFirst();
	if (!row) throw notFound();

	const changed: string[] = [];
	const patch: Partial<{
		name: string;
		status: string;
		max_concurrent: number;
		max_run_minutes: number;
		default_tier: string;
		tiers: string | null;
		budget: string | null;
		secret_enc: string;
		config: string;
	}> = {};

	if (body.name !== undefined) {
		const name = validateRunnerName(body.name);
		if (name !== row.name) {
			await assertRunnerNameAvailable(db, actor.userId, name, id);
			patch.name = name;
			changed.push('name');
		}
	}
	if (body.status !== undefined) {
		if (body.status !== 'active' && body.status !== 'paused') {
			throw new ApiFail(422, 'invalid_field', '"status" must be "active" or "paused"', { field: 'status' });
		}
		if (body.status !== row.status) {
			patch.status = body.status;
			changed.push('status');
		}
	}
	if (body.max_concurrent !== undefined) {
		const cap = validateBoundedInt(body.max_concurrent, 'max_concurrent', 1, 100);
		if (cap !== row.max_concurrent) {
			patch.max_concurrent = cap;
			changed.push('max_concurrent');
		}
	}
	if (body.max_run_minutes !== undefined) {
		const minutes = validateBoundedInt(body.max_run_minutes, 'max_run_minutes', 1, 24 * 60);
		if (minutes !== row.max_run_minutes) {
			patch.max_run_minutes = minutes;
			changed.push('max_run_minutes');
		}
	}
	if (body.default_tier !== undefined) {
		const tier = requireTier(body.default_tier, 'default_tier');
		if (tier !== row.default_tier) {
			patch.default_tier = tier;
			changed.push('default_tier');
		}
	}
	if (body.tiers !== undefined) {
		const tiers = validateTierOverrides(body.tiers);
		const serialized = tiers ? JSON.stringify(tiers) : null;
		if (serialized !== row.tiers) {
			patch.tiers = serialized;
			changed.push('tiers');
		}
	}
	if (body.budget !== undefined) {
		const budget = validateRunnerBudget(body.budget);
		const serialized = budget ? JSON.stringify(budget) : null;
		if (serialized !== row.budget) {
			patch.budget = serialized;
			changed.push('budget');
		}
	}
	if (body.api_key !== undefined) {
		if (row.type === 'local') {
			throw new ApiFail(422, 'invalid_field', 'Local runners take no "api_key"', { field: 'api_key' });
		}
		// Replace-key: ping-validated before anything changes, so a bad paste
		// leaves the working key in place. In-flight sessions are unaffected;
		// the next launch uses the new key (USER_FLOWS.md flow 16).
		patch.secret_enc = await validatedProviderKey(env, row.type as RunnerType, body.api_key, ping);
		changed.push('api_key');
	}
	if (body.config !== undefined) {
		if (row.type !== 'local') {
			throw new ApiFail(422, 'invalid_field', 'Only local runners take a "config" here', { field: 'config' });
		}
		const config = JSON.stringify(validateLocalConfig(body.config));
		if (config !== row.config) {
			patch.config = config;
			changed.push('config');
		}
	}

	if (changed.length === 0) return serializeRunner(row);

	await runAtomic(env, [
		db
			.updateTable('runner')
			.set({ ...patch, updated_at: Date.now() })
			.where('id', '=', id)
			.compile(),
		eventInsert(db, actor, {
			type: 'runner.updated',
			payload: {
				runner_id: id,
				name: patch.name ?? row.name,
				changed,
				...(patch.status !== undefined ? { status: patch.status } : {})
			}
		})
	]);
	// Pausing stops new assignments immediately AND cancels the runner's
	// not-yet-acknowledged `assigned` runs — nothing is running yet, so the
	// cancel is free and the issues return to the pool. `launching`/`running`
	// runs finish (SPEC.md "Pausing a runner").
	if (patch.status === 'paused') {
		await cancelAssignedRuns(db, env, { userId: actor.userId, runnerId: id }, 'runner paused');
	}
	return getRunner(db, actor.userId, id);
}

// ---------------------------------------------------------------------------
// Runner tokens: registration (create/reconnect) and rotation

function generateRunnerToken(): string {
	// Distinct prefix from API keys: a runner token is a different credential
	// kind, valid only on the protocol endpoints.
	return `tines_rt_${randomString(40)}`;
}

/**
 * `POST /api/v1/runners/register` (user API key or session auth): the
 * daemon's first start creates the runner; a later start that lost its
 * stored token reconnects by name — same row, history, and rule references,
 * with a freshly minted token replacing the old one (which is invalidated,
 * exactly like rotate-token).
 */
export async function registerRunner(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	body: RegisterRunnerRequest
): Promise<RunnerTokenResponse> {
	const name = validateRunnerName(body.name);
	const token = generateRunnerToken();
	const tokenHash = await sha256Hex(token);
	const now = Date.now();

	const existing = await db
		.selectFrom('runner')
		.select(['id', 'type', 'config'])
		.where('user_id', '=', actor.userId)
		.where('name', '=', name)
		.executeTakeFirst();
	if (existing && existing.type !== 'local') {
		throw new ApiFail(
			422,
			'duplicate_runner_name',
			`A ${existing.type} runner named "${name}" already exists; pick another --name for the daemon`,
			{ field: 'name', existing_runner_id: existing.id }
		);
	}

	if (existing) {
		// Reconnect: the row, history, and rule references are untouched, and
		// only fields the daemon actually sent are updated — server-side edits
		// (max_run_minutes, default_tier…) survive a daemon restart. Config is
		// overlaid the same way; a harness change away from `custom` drops a
		// now-meaningless stored command template.
		let existingConfig: Record<string, unknown> = {};
		try {
			existingConfig = JSON.parse(existing.config) as Record<string, unknown>;
		} catch {
			// An unreadable config column starts over from the request.
		}
		if (body.harness !== undefined && body.harness !== 'custom' && body.command === undefined) {
			delete existingConfig.command;
		}
		const config = validateLocalConfig({
			...existingConfig,
			...(body.harness !== undefined ? { harness: body.harness } : {}),
			...(body.command !== undefined ? { command: body.command } : {}),
			...(body.hostname !== undefined ? { hostname: body.hostname } : {}),
			...(body.platform !== undefined ? { platform: body.platform } : {})
		});
		const changed = ['runner_token', 'config'];
		const patch: Partial<{
			max_concurrent: number;
			max_run_minutes: number;
			default_tier: string;
		}> = {};
		if (body.max_concurrent !== undefined) {
			patch.max_concurrent = validateBoundedInt(body.max_concurrent, 'max_concurrent', 1, 100);
			changed.push('max_concurrent');
		}
		if (body.max_run_minutes !== undefined) {
			patch.max_run_minutes = validateBoundedInt(body.max_run_minutes, 'max_run_minutes', 1, 24 * 60);
			changed.push('max_run_minutes');
		}
		if (body.default_tier !== undefined) {
			patch.default_tier = requireTier(body.default_tier, 'default_tier');
			changed.push('default_tier');
		}
		await runAtomic(env, [
			db
				.updateTable('runner')
				.set({
					...patch,
					config: JSON.stringify(config),
					runner_token_hash: tokenHash,
					last_seen_at: now,
					updated_at: now
				})
				.where('id', '=', existing.id)
				.compile(),
			eventInsert(db, actor, {
				type: 'runner.updated',
				payload: { runner_id: existing.id, name, changed, reconnected: true }
			})
		]);
		return { runner: await getRunner(db, actor.userId, existing.id), runner_token: token };
	}

	const config = validateLocalConfig({
		...(body.harness !== undefined ? { harness: body.harness } : {}),
		...(body.command !== undefined ? { command: body.command } : {}),
		...(body.hostname !== undefined ? { hostname: body.hostname } : {}),
		...(body.platform !== undefined ? { platform: body.platform } : {})
	});
	const maxConcurrent =
		body.max_concurrent === undefined ? 1 : validateBoundedInt(body.max_concurrent, 'max_concurrent', 1, 100);
	const maxRunMinutes =
		body.max_run_minutes === undefined
			? 30
			: validateBoundedInt(body.max_run_minutes, 'max_run_minutes', 1, 24 * 60);
	const defaultTier =
		body.default_tier === undefined ? 'balanced' : requireTier(body.default_tier, 'default_tier');

	const id = newId('rnr');
	await runAtomic(env, [
		db
			.insertInto('runner')
			.values({
				id,
				user_id: actor.userId,
				type: 'local',
				name,
				status: 'active',
				max_concurrent: maxConcurrent,
				max_run_minutes: maxRunMinutes,
				default_tier: defaultTier,
				tiers: null,
				budget: null,
				config: JSON.stringify(config),
				secret_enc: null,
				runner_token_hash: tokenHash,
				last_seen_at: now,
				launch_failures: 0,
				backoff_until: null,
				created_at: now,
				updated_at: now
			})
			.compile(),
		eventInsert(db, actor, {
			type: 'runner.registered',
			payload: { runner_id: id, name, runner_type: 'local' }
		})
	]);
	return { runner: await getRunner(db, actor.userId, id), runner_token: token };
}

/**
 * `POST /api/v1/runners/:id/rotate-token` (user auth — run keys are fenced
 * off `/runners*`, and runner tokens cannot call outside the protocol):
 * invalidates the old token in place and returns the new one exactly once.
 * The runner row, history, and rule references are untouched — the daemon's
 * next poll 401s until the user drops the new token into its config.
 */
export async function rotateRunnerToken(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string
): Promise<RunnerTokenResponse> {
	const runner = await db
		.selectFrom('runner')
		.select(['id', 'name', 'type'])
		.where('id', '=', id)
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!runner) throw notFound();
	if (runner.type !== 'local') {
		throw new ApiFail(422, 'invalid_runner_type', 'Only local runners carry a runner token to rotate');
	}
	const token = generateRunnerToken();
	await runAtomic(env, [
		db
			.updateTable('runner')
			.set({ runner_token_hash: await sha256Hex(token), updated_at: Date.now() })
			.where('id', '=', id)
			.compile(),
		eventInsert(db, actor, {
			type: 'runner.updated',
			payload: { runner_id: id, name: runner.name, changed: ['runner_token'] }
		})
	]);
	return { runner: await getRunner(db, actor.userId, id), runner_token: token };
}

// ---------------------------------------------------------------------------
// Removal: reject-by-default; `force` cascades through rules and pins

export interface RunnerRemovalRefs {
	activeRuns: number;
	/** Rules with a target pointing at the runner, with their parsed targets. */
	rules: { id: string; label: string; targets: RoutingTarget[] }[];
	/** Issues pinned to the runner. */
	pins: { issue_id: string; project_id: string; ref: string }[];
}

export interface RunnerRemovalPlan {
	/** Rules to rewrite with the runner's targets stripped. */
	ruleUpdates: { id: string; label: string; targets: RoutingTarget[]; emptied: boolean }[];
	pinClears: { issue_id: string; project_id: string; ref: string }[];
}

/**
 * The removal decision, isolated for tests. Active runs always block (cancel
 * them first — `force` is about references, not live work). References block
 * unless forced; forcing strips rule targets and clears pins. A rule the
 * cascade empties is flagged (empty targets), never deleted: the scope choice
 * is user intent worth preserving.
 */
export function planRunnerRemoval(
	runner: { id: string; name: string },
	refs: RunnerRemovalRefs,
	force: boolean
): RunnerRemovalPlan {
	if (refs.activeRuns > 0) {
		throw new ApiFail(
			422,
			'runner_busy',
			`Cannot remove runner "${runner.name}": it has ${refs.activeRuns} active run${refs.activeRuns === 1 ? '' : 's'}. Cancel them (or let them finish) first.`,
			{ active_runs: refs.activeRuns }
		);
	}
	if ((refs.rules.length > 0 || refs.pins.length > 0) && !force) {
		const parts: string[] = [];
		if (refs.rules.length > 0) {
			parts.push(
				`${refs.rules.length} routing rule${refs.rules.length === 1 ? '' : 's'} (${refs.rules.map((r) => r.label).join(', ')})`
			);
		}
		if (refs.pins.length > 0) {
			parts.push(
				`${refs.pins.length} issue pin${refs.pins.length === 1 ? '' : 's'} (${refs.pins.map((p) => p.ref).join(', ')})`
			);
		}
		throw new ApiFail(
			422,
			'runner_referenced',
			`Cannot remove runner "${runner.name}": it is referenced by ${parts.join(' and ')}. Pass "force": true to strip these references (emptied rules are kept, flagged "no targets") — or pause the runner instead if it might come back.`,
			{
				rules: refs.rules.map((r) => ({ rule_id: r.id, label: r.label })),
				pins: refs.pins.map((p) => ({ issue_id: p.issue_id, ref: p.ref }))
			}
		);
	}
	return {
		ruleUpdates: refs.rules.map((rule) => {
			const targets = rule.targets.filter((t) => t.runner_id !== runner.id);
			return { id: rule.id, label: rule.label, targets, emptied: targets.length === 0 };
		}),
		pinClears: refs.pins
	};
}

export async function deleteRunner(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	force: boolean
): Promise<void> {
	const runner = await db
		.selectFrom('runner')
		.select(['id', 'name', 'type'])
		.where('id', '=', id)
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!runner) throw notFound();

	const activeRuns = await db
		.selectFrom('agent_run')
		.select((eb) => eb.fn.countAll<number>().as('n'))
		.where('runner_id', '=', id)
		.where('status', 'in', [...ACTIVE_RUN_STATUSES])
		.executeTakeFirst();
	// Target lists are small JSON arrays; filtering in JS beats JSON1 gymnastics.
	const ruleRows = await db
		.selectFrom('routing_rule')
		.leftJoin('project', 'project.id', 'routing_rule.project_id')
		.leftJoin('workflow_state', 'workflow_state.id', 'routing_rule.workflow_state_id')
		.select([
			'routing_rule.id',
			'routing_rule.targets',
			'routing_rule.project_id',
			'routing_rule.workflow_state_id',
			'project.name as project_name',
			'workflow_state.name as state_name'
		])
		.where('routing_rule.user_id', '=', actor.userId)
		.execute();
	const rules = ruleRows
		.map((r) => ({
			id: r.id,
			label: scopeLabel({
				projectId: r.project_id,
				projectName: r.project_name,
				workflowStateId: r.workflow_state_id,
				stateName: r.state_name
			}),
			targets: JSON.parse(r.targets) as RoutingTarget[]
		}))
		.filter((r) => r.targets.some((t) => t.runner_id === id));
	const pinRows = await db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.select(['issue.id', 'issue.number', 'issue.project_id', 'project.name as project_name'])
		.where('issue.pinned_runner_id', '=', id)
		.execute();

	const plan = planRunnerRemoval(runner, {
		activeRuns: Number(activeRuns?.n ?? 0),
		rules,
		pins: pinRows.map((p) => ({
			issue_id: p.id,
			project_id: p.project_id,
			ref: `${p.project_name}/${p.number}`
		}))
	}, force);

	// The active-run guard above is a read before the batch (TOCTOU): a run
	// can go active between the check and the writes, and an unguarded batch
	// would then silently delete a runner with live work. Every statement in
	// the batch therefore re-checks "no active run" inside itself, so a race
	// makes the whole batch a no-op instead — detected below via the runner
	// delete's rows-affected.
	const noActiveRuns = sql<boolean>`NOT EXISTS (
		SELECT 1 FROM agent_run
		WHERE runner_id = ${id} AND status IN (${sql.join([...ACTIVE_RUN_STATUSES])})
	)`;
	const guardedEvent = (input: {
		type: string;
		issueId?: string | null;
		projectId?: string | null;
		payload: Record<string, unknown>;
	}): CompiledQuery =>
		sql`
			INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
			SELECT ${newId('evt')}, ${actor.userId}, ${input.type}, ${actor.userId}, ${actor.apiKeyId ?? null},
				${input.issueId ?? null}, ${input.projectId ?? null}, ${JSON.stringify(input.payload)}, ${Date.now()}
			WHERE ${noActiveRuns}`.compile(db);

	const now = Date.now();
	const queries: CompiledQuery[] = [];
	for (const update of plan.ruleUpdates) {
		queries.push(
			db
				.updateTable('routing_rule')
				.set({ targets: JSON.stringify(update.targets), updated_at: now })
				.where('id', '=', update.id)
				.where(noActiveRuns)
				.compile(),
			guardedEvent({
				type: 'routing_rule.updated',
				payload: {
					rule_id: update.id,
					scope_label: update.label,
					removed_runner_id: id,
					removed_runner_name: runner.name,
					targets_remaining: update.targets.length,
					...(update.emptied ? { emptied: true } : {})
				}
			})
		);
	}
	for (const pin of plan.pinClears) {
		queries.push(
			db
				.updateTable('issue')
				.set({ pinned_runner_id: null, pinned_tier: null, updated_at: now })
				.where('id', '=', pin.issue_id)
				.where(noActiveRuns)
				.compile(),
			guardedEvent({
				type: 'issue.updated',
				issueId: pin.issue_id,
				projectId: pin.project_id,
				payload: {
					changed: ['pin'],
					pinned_runner_id: null,
					pinned_tier: null,
					unpinned_by_runner_removal: runner.name
				}
			})
		);
	}
	queries.push(
		// Blanket pin clear: a pin created between the read above and this
		// batch would otherwise break the runner delete's foreign key. The
		// per-pin statements before it carry the events; this is the backstop.
		db
			.updateTable('issue')
			.set({ pinned_runner_id: null, pinned_tier: null })
			.where('pinned_runner_id', '=', id)
			.where(noActiveRuns)
			.compile(),
		// Ended runs go with their runner (pause keeps history; delete does
		// not); their run keys lose the provenance link but stay on record.
		db
			.updateTable('api_key')
			.set({ agent_run_id: null })
			.where('agent_run_id', 'in', db.selectFrom('agent_run').select('id').where('runner_id', '=', id))
			.where(noActiveRuns)
			.compile(),
		db.deleteFrom('agent_run').where('runner_id', '=', id).where(noActiveRuns).compile(),
		// By this point a passing guard has emptied agent_run for the runner,
		// so this delete's own guard only bites when the batch no-oped — and
		// then it also spares the FK from the still-referencing ended runs.
		db.deleteFrom('runner').where('id', '=', id).where(noActiveRuns).compile(),
		guardedEvent({
			type: 'runner.removed',
			payload: {
				runner_id: id,
				name: runner.name,
				runner_type: runner.type,
				...(force ? { forced: true } : {})
			}
		})
	);
	// R2 deletes cannot join a D1 batch, so the runs' full-log objects are
	// identified before the batch and dropped after it succeeds. A failure
	// here just leaves orphans, which the sweep's orphan pass collects.
	// Only the runs that actually spilled own objects, and the overwhelming
	// majority never do. Without this filter a runner with a long history
	// costs one R2 list per run and blows the Worker's subrequest budget —
	// the same filter the retention pass uses.
	const doomedRuns = await db
		.selectFrom('agent_run')
		.select(['id', 'user_id'])
		.where('runner_id', '=', id)
		.where((eb) => eb.or([eb('log_bytes_dropped', '>', 0), eb('log_raw_bytes', '>', 0)]))
		.execute();
	const results = await runAtomic(env, queries);
	// The runner delete is the second-to-last statement.
	if ((results[results.length - 2]?.meta.changes ?? 0) === 0) {
		const survivor = await db
			.selectFrom('runner')
			.select('id')
			.where('id', '=', id)
			.executeTakeFirst();
		// No survivor = a concurrent delete already removed it; that's done.
		if (survivor) {
			throw new ApiFail(
				422,
				'runner_busy',
				`Cannot remove runner "${runner.name}": a run went active while removing it. Cancel it (or let it finish) and retry.`
			);
		}
	}
	for (const run of doomedRuns) {
		await deleteRunLogObjects(env, run.user_id, run.id).catch((e) =>
			console.error(`deleting run-log objects for run ${run.id} failed:`, e)
		);
	}
}
