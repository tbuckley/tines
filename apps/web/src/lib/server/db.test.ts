import { describe, expect, it } from 'vitest';
import { createTestDb, instrumentLatency } from './api/test-db';
import { batchingD1, getDb, MAX_BATCHED_READS, newId, randomString } from './db';

describe('randomString', () => {
	it('produces the requested length from the 62-char alphabet', () => {
		for (const len of [1, 16, 40, 100]) {
			const s = randomString(len);
			expect(s).toHaveLength(len);
			expect(s).toMatch(/^[0-9a-zA-Z]+$/);
		}
	});

	it('does not repeat (sanity check on randomness)', () => {
		const seen = new Set(Array.from({ length: 50 }, () => randomString(16)));
		expect(seen.size).toBe(50);
	});
});

describe('newId', () => {
	it('prefixes ids with the entity tag', () => {
		expect(newId('iss')).toMatch(/^iss_[0-9a-zA-Z]{16}$/);
	});
});

describe('ConcurrentD1Dialect', () => {
	it('fans out Promise.all instead of serializing on one connection', async () => {
		// Serialized on one connection, four reads take four waves; concurrent,
		// they start together and `batchingD1` sends them as one request. Waves
		// are counted, not timed, so this holds on a loaded CI runner.
		const { env, sqls, waves } = instrumentLatency(createTestDb(), 20);
		const db = getDb(env);
		await Promise.all(
			Array.from({ length: 4 }, () => db.selectFrom('project').select(['id']).execute())
		);
		expect(sqls).toHaveLength(4);
		expect(waves.max).toBe(1);
	});

	it('is what getDb hands out (the stock dialect would mutex)', () => {
		const { env } = createTestDb();
		expect(getDb(env).getExecutor().adapter.supportsMultipleConnections).toBe(true);
	});

	/**
	 * The invariant that makes lifting the mutex safe: a Kysely transaction
	 * pins one connection, and concurrent unrelated statements would interleave
	 * into it. Multi-statement writes must go through runAtomic() -> DB.batch().
	 */
	it('no source file uses db.transaction()', () => {
		const sources = import.meta.glob('/src/**/*.ts', {
			query: '?raw',
			import: 'default',
			eager: true
		}) as Record<string, string>;
		// Comments discuss the invariant by name, so strip them before matching.
		const stripComments = (body: string) =>
			body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
		const offenders = Object.entries(sources)
			.filter(([path]) => !path.endsWith('.test.ts') && !path.endsWith('test-db.ts'))
			.filter(([, body]) => /\.transaction\s*\(/.test(stripComments(body)))
			.map(([path]) => path);
		expect(offenders).toEqual([]);
	});
});

describe('batchingD1', () => {
	/** A D1 stand-in that records each request: a lone statement or a batch. */
	function fakeD1(failBatchWhen: (sqls: string[]) => boolean = () => false) {
		const requests: string[][] = [];
		const statement = (sql: string) => ({
			bind: () => ({
				sql,
				all: async () => {
					requests.push([sql]);
					if (sql.includes('broken')) throw new Error('no such table: broken');
					return { results: [{ sql }], success: true, meta: {} };
				},
				run: async () => {
					requests.push([sql]);
					return { results: [], success: true, meta: {} };
				}
			})
		});
		const database = {
			prepare: statement,
			batch: async (stmts: { sql: string }[]) => {
				const sqls = stmts.map((s) => s.sql);
				requests.push(sqls);
				if (failBatchWhen(sqls)) throw new Error('batch failed');
				return sqls.map((sql) => ({ results: [{ sql }], success: true, meta: {} }));
			}
		};
		return { db: batchingD1(database as unknown as Env['DB']), requests };
	}
	const read = (db: Env['DB'], sql: string) =>
		db.prepare(sql).bind().all() as Promise<{ results: { sql: string }[] }>;

	it('sends reads started in the same task as one batch, each getting its own rows', async () => {
		const { db, requests } = fakeD1();
		const results = await Promise.all([
			read(db, 'select 1'),
			Promise.resolve().then(() => read(db, 'select 2')),
			read(db, 'with x as (select 1) select * from x')
		]);
		expect(requests).toEqual([['select 1', 'with x as (select 1) select * from x', 'select 2']]);
		expect(results.map((r) => r.results[0].sql)).toEqual([
			'select 1',
			'select 2',
			'with x as (select 1) select * from x'
		]);
	});

	it('sends a lone read on its own', async () => {
		const { db, requests } = fakeD1();
		await read(db, 'select 1');
		expect(requests).toEqual([['select 1']]);
	});

	it('never batches a write', async () => {
		const { db, requests } = fakeD1();
		await Promise.all([
			read(db, 'select 1'),
			read(db, 'update issue set title = ?'),
			read(db, 'with x as (select 1) insert into t select * from x')
		]);
		expect(requests).toHaveLength(3);
	});

	it('re-sends each read alone when the batch fails, so only the broken one rejects', async () => {
		const { db, requests } = fakeD1(() => true);
		const [ok, broken] = await Promise.allSettled([
			read(db, 'select 1'),
			read(db, 'select * from broken')
		]);
		expect(ok).toMatchObject({ status: 'fulfilled', value: { results: [{ sql: 'select 1' }] } });
		expect(broken).toMatchObject({ status: 'rejected', reason: { message: /broken/ } });
		expect(requests).toEqual([
			['select 1', 'select * from broken'],
			['select 1'],
			['select * from broken']
		]);
	});

	it(`splits a fan-out wider than ${MAX_BATCHED_READS} reads`, async () => {
		const { db, requests } = fakeD1();
		await Promise.all(
			Array.from({ length: MAX_BATCHED_READS + 1 }, (_, i) => read(db, `select ${i}`))
		);
		expect(requests.map((r) => r.length)).toEqual([MAX_BATCHED_READS, 1]);
	});
});
