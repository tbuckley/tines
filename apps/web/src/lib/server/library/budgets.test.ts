import { CompiledQuery, sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { validatePackageBatch, PACKAGE_BATCH_LIMITS as limits } from './budgets';
import { createTestDb } from '../api/test-db';
import { insertValues } from '../api/query-guard';

describe('package compiled budgets (synthetic, not native D1 capacity evidence)', () => {
	it('counts every query, including read guards/receipt/events, and accepts exactly 800', () => {
		const query = CompiledQuery.raw('SELECT 1');
		expect(validatePackageBatch(Array(limits.statements).fill(query)).statements).toBe(800);
		expect(() => validatePackageBatch(Array(limits.statements + 1).fill(query))).toThrow(
			'statements is 801'
		);
	});
	it('counts parameters added by transaction guards as well as object values', () => {
		const t = createTestDb();
		const predicate = sql<boolean>`${sql.join(Array(88).fill(sql`1 = ${'guard'}`), sql` AND `)}`;
		const query = insertValues(
			t.db,
			'label',
			{
				id: 'label',
				user_id: 'owner',
				name: 'Label',
				color: 'blue',
				description: '',
				created_at: 1,
				updated_at: 1
			},
			{ predicate }
		);
		expect(query.parameters).toHaveLength(95);
		expect(() => validatePackageBatch([query])).toThrow('parameters_per_statement is 95');
		expect(
			validatePackageBatch([CompiledQuery.raw('SELECT 1', Array(90).fill(0))]).max_parameters
		).toBe(90);
		expect(() => validatePackageBatch([CompiledQuery.raw('SELECT 1', Array(91).fill(0))])).toThrow(
			'parameters_per_statement'
		);
	});
	it('measures UTF-8 SQL bytes at the exact bound and one byte over', () => {
		const sqlText = 'é'.repeat(limits.sql_bytes_per_statement / 2);
		expect(validatePackageBatch([CompiledQuery.raw(sqlText)]).max_sql_bytes).toBe(
			limits.sql_bytes_per_statement
		);
		expect(() => validatePackageBatch([CompiledQuery.raw(sqlText + 'x')])).toThrow(
			'sql_bytes_per_statement'
		);
	});
	it('measures each stored text or binary value including rendered payloads and event JSON', () => {
		const value = '🧪'.repeat(limits.value_bytes / 4);
		const query = (v: unknown) => CompiledQuery.raw('SELECT ?', [v]);
		expect(validatePackageBatch([query(value)]).max_value_bytes).toBe(limits.value_bytes);
		expect(() => validatePackageBatch([query(value + 'x')])).toThrow('value_bytes');
		expect(validatePackageBatch([query(new Uint8Array(limits.value_bytes))]).max_value_bytes).toBe(
			limits.value_bytes
		);
		expect(() => validatePackageBatch([query(new ArrayBuffer(limits.value_bytes + 1))])).toThrow(
			'value_bytes'
		);
	});
	it('returns structured oversize diagnostics without including sensitive bound values', () => {
		const query = CompiledQuery.raw('SELECT ?', ['secret'.repeat(limits.value_bytes)]);
		try {
			validatePackageBatch([query]);
			throw new Error('expected rejection');
		} catch (error) {
			expect(error).toMatchObject({
				status: 422,
				code: 'package_too_large',
				details: { field: 'value_bytes', statement: 0, maximum: limits.value_bytes }
			});
		}
	});
});

import { inheritedPackage } from '../../../../../../packages/shared/src/library/fixtures';
import { validatePackageStructure } from './budgets';
it('does not budget a retired inheritance phase', () => {
	const document = inheritedPackage();
	const prompt = document.context[0];
	if (prompt.kind !== 'prompt') throw new Error('fixture');
	for (let i = 0; i < 391; i++)
		document.context.push({ ...prompt, id: `more:${i}`, name: `prompt-${i}` });
	expect(validatePackageStructure(document)).toBe(799);
	const skill = document.context.find((c) => c.kind === 'skill')!;
	if (skill.kind !== 'skill') throw new Error('fixture');
	skill.files.push({ id: 'one-more', path: 'one.txt', content: '' });
	expect(validatePackageStructure(document)).toBe(800);
});
