import type {
	CreateUserModelRateRequest,
	SupervisorRatesResponse,
	UserModelRate
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { newId } from '$lib/server/db';
import { runAtomic, ApiFail, requireString } from './core';
import { CODEX_RATES, RATE_PATTERN } from '../supervisor/codex-pricing';
import { currentUserRate, repriceUnpricedRuns, serializeUserRate } from '../supervisor/user-rates';

const rateFields = ['input_rate', 'cache_read_rate', 'cache_write_rate', 'output_rate'] as const;

function rate(value: unknown, field: string, nullable = false): string | null {
	if (nullable && value === null) return null;
	if (typeof value !== 'string' || !RATE_PATTERN.test(value)) {
		throw new ApiFail(
			422,
			'invalid_field',
			`"${field}" must be a decimal with at most 9 fractional digits`,
			{
				field
			}
		);
	}
	const whole = value.split('.')[0]!;
	if (whole.length > 7 || Number(whole) > 1_000_000) {
		throw new ApiFail(422, 'invalid_field', `"${field}" must be at most 1,000,000`, { field });
	}
	return value;
}

export function validateCreateRate(body: CreateUserModelRateRequest): CreateUserModelRateRequest {
	const model = requireString(body.model, 'model', { max: 200 }).trim();
	if (!model)
		throw new ApiFail(422, 'invalid_field', '"model" must not be empty', { field: 'model' });
	if (CODEX_RATES.some((entry) => entry.model === model)) {
		throw new ApiFail(422, 'rate_builtin_exists', `A built-in rate already exists for ${model}`);
	}
	return {
		model,
		input_rate: rate(body.input_rate, 'input_rate')!,
		cache_read_rate: rate(body.cache_read_rate, 'cache_read_rate')!,
		cache_write_rate: rate(body.cache_write_rate, 'cache_write_rate', true),
		output_rate: rate(body.output_rate, 'output_rate')!,
		...(body.copied_from !== undefined
			? { copied_from: requireString(body.copied_from, 'copied_from') }
			: {}),
		reprice: body.reprice === true
	};
}

export async function listRates(
	db: Kysely<Database>,
	userId: string
): Promise<SupervisorRatesResponse> {
	const [rows, unpriced] = await Promise.all([
		db
			.selectFrom('user_model_rate')
			.selectAll()
			.where('user_id', '=', userId)
			.where('retired_at', 'is', null)
			.orderBy('model')
			.orderBy('version', 'desc')
			.execute(),
		db
			.selectFrom('agent_run')
			.select(['model', sql<number>`count(*)`.as('runs')])
			.where('user_id', '=', userId)
			.where('model', 'is not', null)
			.where(
				sql<boolean>`json_extract(usage, '$.pricing.status') = 'unpriced' AND json_extract(usage, '$.pricing.reason') IN ('unsupported_model', 'missing_rate')`
			)
			.groupBy('model')
			.orderBy('model')
			.execute()
	]);
	const current = new Map<string, UserModelRate>();
	for (const row of rows)
		if (!current.has(row.model)) current.set(row.model, serializeUserRate(row));
	const builtin = new Map<string, (typeof CODEX_RATES)[number]>();
	for (const entry of CODEX_RATES) if (!builtin.has(entry.model)) builtin.set(entry.model, entry);
	return {
		user_rates: [...current.values()],
		builtin: [...builtin.values()].map((entry) => ({ model: entry.model, rates: entry.rates })),
		unpriced_models: unpriced.map((row) => ({ model: row.model!, runs: Number(row.runs) }))
	};
}

export async function createRate(
	db: Kysely<Database>,
	env: Env,
	userId: string,
	body: CreateUserModelRateRequest,
	now = Date.now()
) {
	const input = validateCreateRate(body);
	const prior = await db
		.selectFrom('user_model_rate')
		.select(sql<number>`coalesce(max(version), 0)`.as('version'))
		.where('user_id', '=', userId)
		.where('model', '=', input.model)
		.executeTakeFirstOrThrow();
	const row = {
		id: newId('umr'),
		user_id: userId,
		model: input.model,
		version: Number(prior.version) + 1,
		input_rate: input.input_rate,
		cache_read_rate: input.cache_read_rate,
		cache_write_rate: input.cache_write_rate,
		output_rate: input.output_rate,
		copied_from: input.copied_from ?? null,
		created_at: now,
		retired_at: null
	};
	await runAtomic(env, [db.insertInto('user_model_rate').values(row).compile()]);
	const repricing = input.reprice
		? await repriceUnpricedRuns(db, env, userId, input.model, now)
		: { repriced: 0, still_unpriced: 0, remaining: 0 };
	return { rate: serializeUserRate(row), ...repricing };
}

export async function repriceRate(
	db: Kysely<Database>,
	env: Env,
	userId: string,
	model: string,
	now = Date.now()
) {
	if (!model || model.length > 200)
		throw new ApiFail(422, 'invalid_field', '"model" must be a valid model id', { field: 'model' });
	return repriceUnpricedRuns(db, env, userId, model, now);
}

export async function retireRate(
	db: Kysely<Database>,
	userId: string,
	id: string,
	now = Date.now()
): Promise<void> {
	const result = await db
		.updateTable('user_model_rate')
		.set({ retired_at: now })
		.where('id', '=', id)
		.where('user_id', '=', userId)
		.where('retired_at', 'is', null)
		.executeTakeFirst();
	if (!result || Number(result.numUpdatedRows) === 0)
		throw new ApiFail(404, 'not_found', 'Rate not found');
}
