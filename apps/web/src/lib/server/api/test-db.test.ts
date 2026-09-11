import { CompiledQuery } from 'kysely';
import { describe, expect, it } from 'vitest';
import { getDb } from '$lib/server/db';
import { createTestDb } from './test-db';

const selectParams = (count: number) => ({
	sql: `select ${Array.from({ length: count }, () => '?').join(', ')}`,
	params: Array.from({ length: count }, (_, i) => i)
});

describe('D1 parameter limit', () => {
	it.each([
		[
			'direct Kysely',
			(count: number) => {
				const t = createTestDb();
				const query = selectParams(count);
				return t.db.executeQuery(CompiledQuery.raw(query.sql, query.params));
			}
		],
		[
			'fake D1 through getDb',
			(count: number) => {
				const t = createTestDb();
				const query = selectParams(count);
				return getDb(t.env).executeQuery(CompiledQuery.raw(query.sql, query.params));
			}
		]
	] as const)('%s accepts 100 bindings and rejects 101', async (_name, execute) => {
		await expect(execute(100)).resolves.toBeDefined();
		await expect(execute(101)).rejects.toThrow(
			'D1 parameter limit exceeded: 101 bound parameters (maximum 100)'
		);
	});

	it('applies the limit per batch statement and rolls back an over-budget batch', async () => {
		const t = createTestDb();
		const legal = selectParams(100);
		await expect(
			t.env.DB.batch([
				t.env.DB.prepare(legal.sql).bind(...legal.params),
				t.env.DB.prepare(legal.sql).bind(...legal.params)
			])
		).resolves.toHaveLength(2);

		const overBudget = selectParams(101);
		await expect(
			t.env.DB.batch([
				t.env.DB.prepare(
					'insert into user (id, name, email, emailVerified, image, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?)'
				).bind('usr_rollback', 'Rollback', 'rollback@example.com', 1, null, 1, 1),
				t.env.DB.prepare(overBudget.sql).bind(...overBudget.params)
			])
		).rejects.toThrow('D1 parameter limit exceeded');
		expect(t.all('select id from user where id = ?', 'usr_rollback')).toEqual([]);
	});

	it('keeps raw fixture and assertion SQL outside the emulated D1 limit', () => {
		const query = selectParams(101);
		expect(createTestDb().all(query.sql, ...query.params)).toHaveLength(1);
	});
});
