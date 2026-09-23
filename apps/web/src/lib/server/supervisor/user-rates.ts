import type { AgentRunUsage, UserModelRate } from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import type { Database, UserModelRateTable } from '$lib/server/db';
import { runAtomic } from '$lib/server/api/core';
import { CODEX_RATES, priceCodexUsage, userRateToCodexRate } from './codex-pricing';

const REPRICE_LIMIT = 200;

export function serializeUserRate(row: UserModelRateTable): UserModelRate {
	return {
		id: row.id,
		model: row.model,
		version: row.version,
		input_rate: row.input_rate,
		cache_read_rate: row.cache_read_rate,
		cache_write_rate: row.cache_write_rate,
		output_rate: row.output_rate,
		copied_from: row.copied_from,
		created_at: row.created_at,
		retired_at: row.retired_at
	};
}

export async function currentUserRate(
	db: Kysely<Database>,
	userId: string,
	model: string
): Promise<UserModelRateTable | undefined> {
	return db
		.selectFrom('user_model_rate')
		.selectAll()
		.where('user_id', '=', userId)
		.where('model', '=', model)
		.where('retired_at', 'is', null)
		.orderBy('version', 'desc')
		.executeTakeFirst();
}

/** Built-ins win; user rates are consulted only for models without a built-in. */
export async function pricingCatalogFor(db: Kysely<Database>, userId: string, model: string) {
	const user = await currentUserRate(db, userId, model);
	const builtin = CODEX_RATES.filter((entry) => entry.model === model);
	if (builtin.length > 0 || !user) return CODEX_RATES;
	return [...CODEX_RATES, userRateToCodexRate(user)];
}

export function repriceQueries(
	db: Kysely<Database>,
	rows: Array<{ id: string; usage: string; created_at: number }>,
	userId: string,
	model: string,
	now: number,
	catalog: Parameters<typeof priceCodexUsage>[1]
): CompiledQuery[] {
	const queries: CompiledQuery[] = [];
	for (const row of rows) {
		let usage: AgentRunUsage;
		try {
			usage = JSON.parse(row.usage) as AgentRunUsage;
		} catch {
			continue;
		}
		const pricing = usage.pricing;
		if (pricing?.status !== 'unpriced' || !pricing.evidence) continue;
		const repriced = priceCodexUsage(
			{
				run: { model, created_at: row.created_at },
				usage,
				evidence: pricing.evidence,
				now
			},
			catalog
		);
		if (repriced.pricing?.status !== 'calculated') continue;
		repriced.pricing.repriced_from = { evaluated_at: pricing.evaluated_at, reason: pricing.reason };
		queries.push(
			db
				.updateTable('agent_run')
				.set({ usage: JSON.stringify(repriced) })
				.where('id', '=', row.id)
				.where('user_id', '=', userId)
				.where('model', '=', model)
				.where(sql<boolean>`json_extract(usage, '$.pricing.status') = 'unpriced'`)
				.compile()
		);
	}
	return queries;
}

/** Opaque page cursor: `<created_at>:<id>` of the last row a pass examined. */
export function parseRepriceCursor(cursor: string | null | undefined) {
	if (!cursor) return null;
	const match = /^(\d+):(\S+)$/.exec(cursor);
	return match ? { created_at: Number(match[1]), id: match[2]! } : null;
}

/**
 * One bounded pass over eligible unpriced runs, oldest first. Runs the current
 * catalog still cannot price stay unpriced, so callers page with `next_cursor`
 * (null once the last page is examined) rather than looping on `remaining`.
 */
export async function repriceUnpricedRuns(
	db: Kysely<Database>,
	env: Env,
	userId: string,
	model: string,
	now = Date.now(),
	cursor: string | null = null
): Promise<{
	repriced: number;
	still_unpriced: number;
	remaining: number;
	next_cursor: string | null;
}> {
	const catalog = await pricingCatalogFor(db, userId, model);
	const after = parseRepriceCursor(cursor);
	let query = db
		.selectFrom('agent_run')
		.select(['id', 'usage', 'created_at'])
		.where('user_id', '=', userId)
		.where('model', '=', model)
		.where('usage', 'is not', null)
		.where(
			sql<boolean>`json_extract(usage, '$.pricing.status') = 'unpriced' AND json_extract(usage, '$.pricing.reason') IN ('unsupported_model', 'missing_rate')`
		);
	if (after)
		query = query.where(
			sql<boolean>`(created_at > ${after.created_at} OR (created_at = ${after.created_at} AND id > ${after.id}))`
		);
	const rows = (await query
		.orderBy('created_at', 'asc')
		.orderBy('id', 'asc')
		.limit(REPRICE_LIMIT)
		.execute()) as Array<{ id: string; usage: string; created_at: number }>;
	const queries = repriceQueries(db, rows, userId, model, now, catalog);
	const results = await runAtomic(env, queries);
	const repriced = results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0);
	const stillUnpriced = rows.length - repriced;
	const remainingRow = await db
		.selectFrom('agent_run')
		.select(sql<number>`count(*)`.as('count'))
		.where('user_id', '=', userId)
		.where('model', '=', model)
		.where(
			sql<boolean>`json_extract(usage, '$.pricing.status') = 'unpriced' AND json_extract(usage, '$.pricing.reason') IN ('unsupported_model', 'missing_rate')`
		)
		.executeTakeFirstOrThrow();
	const last = rows.at(-1);
	return {
		repriced,
		still_unpriced: stillUnpriced,
		remaining: Number(remainingRow.count),
		next_cursor: rows.length === REPRICE_LIMIT && last ? `${last.created_at}:${last.id}` : null
	};
}
