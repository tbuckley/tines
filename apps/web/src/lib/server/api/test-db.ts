/**
 * Unit-test DB harness: the real migrations applied to an in-memory SQLite
 * (node:sqlite), exposed both as a Kysely instance (for the modules' reads)
 * and as a fake `Env` whose `DB.batch` runs statements in one transaction —
 * the shape runAtomic expects — so tests can exercise actual batch order,
 * guards, and foreign keys instead of mocking them away.
 *
 * Test-only: nothing in the app imports this module.
 */
import {
	CompiledQuery,
	Kysely,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
	type DatabaseConnection,
	type Dialect,
	type Driver,
	type QueryResult
} from 'kysely';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from '$lib/server/db';

// The real migration files, in order (glob keys sort lexicographically, and
// the files are numbered).
const migrations = import.meta.glob('../../../../migrations/*.sql', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const isReader = (sqlText: string) => /^\s*(select|with|pragma)\b/i.test(sqlText);

/** Everything this codebase binds: strings, numbers, and NULLs. */
type SqlParam = string | number | bigint | null;

function runStatement<R>(
	sqlite: DatabaseSync,
	sqlText: string,
	params: readonly unknown[]
): QueryResult<R> {
	const stmt = sqlite.prepare(sqlText);
	if (isReader(sqlText)) return { rows: stmt.all(...(params as SqlParam[])) as R[] };
	const info = stmt.run(...(params as SqlParam[]));
	return { rows: [], numAffectedRows: BigInt(info.changes) };
}

class NodeSqliteConnection implements DatabaseConnection {
	constructor(
		private readonly sqlite: DatabaseSync,
		private readonly log: string[]
	) {}
	executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
		this.log.push(compiled.sql);
		return Promise.resolve(runStatement<R>(this.sqlite, compiled.sql, compiled.parameters));
	}
	// eslint-disable-next-line require-yield
	async *streamQuery(): AsyncIterableIterator<never> {
		throw new Error('streaming is not supported by the test harness');
	}
}

function dialectFor(sqlite: DatabaseSync, log: string[]): Dialect {
	const connection = new NodeSqliteConnection(sqlite, log);
	const driver: Driver = {
		init: async () => {},
		acquireConnection: async () => connection,
		beginTransaction: async (conn) => {
			await conn.executeQuery(CompiledQuery.raw('begin'));
		},
		commitTransaction: async (conn) => {
			await conn.executeQuery(CompiledQuery.raw('commit'));
		},
		rollbackTransaction: async (conn) => {
			await conn.executeQuery(CompiledQuery.raw('rollback'));
		},
		releaseConnection: async () => {},
		destroy: async () => {}
	};
	return {
		createAdapter: () => new SqliteAdapter(),
		createDriver: () => driver,
		createIntrospector: (db) => new SqliteIntrospector(db),
		createQueryCompiler: () => new SqliteQueryCompiler()
	};
}

interface BoundStatement {
	sqlText: string;
	params: unknown[];
	/**
	 * The slice of D1's statement API kysely-d1 calls, so `getDb(env)` works
	 * over this fake too — route handlers can then run against the harness
	 * end to end.
	 */
	all(): Promise<{
		results: unknown[];
		success: true;
		error?: undefined;
		meta: { changes: number; last_row_id: null };
	}>;
}

export interface TestDb {
	db: Kysely<Database>;
	env: Env;
	sqlite: DatabaseSync;
	/** Convenience raw read for assertions. */
	all: (sqlText: string, ...params: unknown[]) => Record<string, unknown>[];
	/**
	 * Start recording SQL. The returned getter yields every statement issued
	 * since the call — for asserting that a shortcut really skipped a query
	 * rather than just returning the same answer.
	 */
	spyOnQueries: () => () => string[];
}

export function createTestDb(): TestDb {
	const sqlite = new DatabaseSync(':memory:');
	const log: string[] = [];
	// D1 enforces foreign keys; the tests must too (batch-order bugs show up
	// as FK failures).
	sqlite.exec('PRAGMA foreign_keys = ON');
	for (const path of Object.keys(migrations).sort()) {
		sqlite.exec(migrations[path]);
	}

	const env = {
		DB: {
			prepare: (sqlText: string) => ({
				bind: (...params: unknown[]): BoundStatement => ({
					sqlText,
					params,
					all: async () => {
						log.push(sqlText);
						const result = runStatement(sqlite, sqlText, params);
						return {
							results: result.rows,
							success: true as const,
							meta: { changes: Number(result.numAffectedRows ?? 0), last_row_id: null }
						};
					}
				})
			}),
			batch: async (statements: BoundStatement[]) => {
				sqlite.exec('BEGIN');
				try {
					const results = statements.map((s) => {
						const result = runStatement(sqlite, s.sqlText, s.params);
						return {
							results: result.rows,
							success: true,
							meta: { changes: Number(result.numAffectedRows ?? 0) }
						};
					});
					sqlite.exec('COMMIT');
					return results;
				} catch (e) {
					sqlite.exec('ROLLBACK');
					throw e;
				}
			}
		}
	} as unknown as Env;

	return {
		db: new Kysely<Database>({ dialect: dialectFor(sqlite, log) }),
		env,
		sqlite,
		all: (sqlText, ...params) =>
			sqlite.prepare(sqlText).all(...(params as SqlParam[])) as Record<string, unknown>[],
		spyOnQueries: () => {
			const from = log.length;
			return () => log.slice(from);
		}
	};
}

/**
 * Wrap a TestDb's D1 binding so every statement takes `latencyMs` and the
 * peak number of concurrently in-flight statements is recorded. Shared by
 * db.test.ts (asserting that ConcurrentD1Dialect really fans out) and
 * nav-perf.test.ts (measuring sequential waves) so the D1 stub shape lives
 * in one place. Statements still run against the same underlying database.
 */
export function instrumentLatency(t: TestDb, latencyMs: number) {
	const sqls: string[] = [];
	let inFlight = 0;
	const conc = { max: 0 };
	const realPrepare = t.env.DB.prepare.bind(t.env.DB);
	const DB = {
		prepare: (sqlText: string) => {
			const st = realPrepare(sqlText);
			return {
				bind: (...params: unknown[]) => {
					const bound = st.bind(...params);
					return {
						...bound,
						all: async () => {
							sqls.push(sqlText);
							conc.max = Math.max(conc.max, ++inFlight);
							await new Promise((r) => setTimeout(r, latencyMs));
							inFlight--;
							return bound.all();
						}
					};
				}
			};
		},
		batch: t.env.DB.batch.bind(t.env.DB)
	};
	return { env: { DB } as unknown as Env, sqls, conc };
}
