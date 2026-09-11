import {
	sql,
	type CompiledQuery,
	type Insertable,
	type Kysely,
	type RawBuilder,
	type SqlBool
} from 'kysely';
import type { Database } from '$lib/server/db';

/** A transaction-time predicate supplied by the owner of an atomic batch. */
export interface QueryGuard {
	predicate: RawBuilder<SqlBool>;
}

/** Compose INSERT SELECT before compilation; never rewrite compiled SQL text. */
export function insertValues<T extends keyof Database>(
	db: Kysely<Database>,
	table: T,
	values: Insertable<Database[T]>,
	guard?: QueryGuard
): CompiledQuery {
	const entries = Object.entries(values);
	const columns = sql.join(entries.map(([key]) => sql.id(key)));
	const parameters = sql.join(entries.map(([, value]) => sql`${value}`));
	return (
		guard
			? sql`INSERT INTO ${sql.id(table)} (${columns}) SELECT ${parameters} WHERE ${guard.predicate}`
			: sql`INSERT INTO ${sql.id(table)} (${columns}) VALUES (${parameters})`
	).compile(db);
}
