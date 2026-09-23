import { describe, expect, it } from 'vitest';
import { createTestDb } from '../api/test-db';
import { seedBase, USER } from './test-fixtures';
import { pricingCatalogFor } from './user-rates';

describe('user model rates', () => {
	it('uses the newest live version and ignores retired rows', async () => {
		const t = createTestDb();
		seedBase(t);
		const insert = t.sqlite.prepare(
			`INSERT INTO user_model_rate (id,user_id,model,version,input_rate,cache_read_rate,cache_write_rate,output_rate,created_at) VALUES (?,?,?,?,?,?,?,?,?)`
		);
		insert.run('umr_1', USER, 'future-model', 1, '1', '0.1', null, '2', 10);
		insert.run('umr_2', USER, 'future-model', 2, '3', '0.3', null, '4', 20);
		expect(
			(await pricingCatalogFor(t.db, USER, 'future-model')).find(
				(entry) => entry.model === 'future-model'
			)
		).toMatchObject({ id: 'user-rate:umr_2', version: 2 });
		t.sqlite.prepare('UPDATE user_model_rate SET retired_at = ? WHERE id = ?').run(30, 'umr_2');
		expect(
			(await pricingCatalogFor(t.db, USER, 'future-model')).find(
				(entry) => entry.model === 'future-model'
			)
		).toMatchObject({ id: 'user-rate:umr_1' });
	});

	it('always prefers a built-in catalog entry', async () => {
		const t = createTestDb();
		seedBase(t);
		t.sqlite
			.prepare(
				`INSERT INTO user_model_rate (id,user_id,model,version,input_rate,cache_read_rate,cache_write_rate,output_rate,created_at) VALUES (?,?,?,?,?,?,?,?,?)`
			)
			.run('umr_3', USER, 'gpt-5.6-sol', 1, '99', '99', '99', '99', 10);
		expect(
			(await pricingCatalogFor(t.db, USER, 'gpt-5.6-sol')).find(
				(entry) => entry.model === 'gpt-5.6-sol'
			)?.id
		).toBe('openai-api-standard:gpt-5.6-sol:2026-09-11:v1');
	});
});
