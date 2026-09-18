import { describe, expect, it } from 'vitest';
import { createTestDb, instrumentLatency } from './api/test-db';
import { getDb, newId, randomString } from './db';

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
		// Peak in-flight statements is the deterministic witness: serialized on
		// one connection it can never exceed 1, concurrent it reaches all 4. No
		// wall-clock assertion — timer callbacks fire arbitrarily late on a
		// loaded CI runner.
		const { env, conc } = instrumentLatency(createTestDb(), 20);
		const db = getDb(env);
		await Promise.all(
			Array.from({ length: 4 }, () => db.selectFrom('project').select(['id']).execute())
		);
		expect(conc.max).toBe(4);
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
