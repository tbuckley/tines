import { describe, expect, it } from 'vitest';
import { createTestDb } from '../api/test-db';
import type { AgentRunUsage, CodexPricingEvidenceV1 } from '@tines/shared';
import { CODEX_RATES, priceCodexUsage } from './codex-pricing';
import { addIssue, addRun, addRunner, seedBase, USER } from './test-fixtures';
import { pricingCatalogFor, repriceUnpricedRuns } from './user-rates';

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

describe('repriceUnpricedRuns', () => {
	const createdAt = Date.parse('2026-09-11T03:30:00Z');
	const evidence = (model: string): CodexPricingEvidenceV1 => ({
		version: 1,
		harness: 'codex',
		model,
		identity_source: 'launch_argument',
		usage_scope: 'thread_total',
		session_mode: 'cold',
		normalization: 'codex-jsonl-v1',
		raw_usage: {
			input_tokens: 1000,
			cached_input_tokens: 600,
			cache_write_input_tokens: 0,
			output_tokens: 100
		},
		model_rerouted: false,
		measurement_status: 'complete',
		terminal_snapshots: 1
	});
	const priced = (model: string) =>
		JSON.stringify(
			priceCodexUsage(
				{
					run: { model, created_at: createdAt },
					usage: {
						input_tokens: 400,
						cache_read_tokens: 600,
						cache_write_tokens: 0,
						output_tokens: 100
					},
					evidence: evidence(model),
					now: createdAt + 1
				},
				CODEX_RATES
			)
		);

	function setup() {
		const t = createTestDb();
		seedBase(t);
		const issueId = addIssue(t, {});
		const runnerId = addRunner(t, {});
		const run = (model: string, usage: string | null, id: string) =>
			addRun(t, { id, issueId, runnerId, model, usage, createdAt, status: 'completed' });
		const usageOf = (id: string) =>
			(t.sqlite.prepare('SELECT usage FROM agent_run WHERE id = ?').get(id) as { usage: string })
				.usage;
		return { t, run, usageOf };
	}

	it('prices only eligible unpriced runs for the model and leaves others byte-identical', async () => {
		const { t, run, usageOf } = setup();
		const unpriced = priced('future-model');
		expect(JSON.parse(unpriced).pricing).toMatchObject({
			status: 'unpriced',
			reason: 'unsupported_model'
		});
		run('future-model', unpriced, 'arun_target');
		run('other-future-model', priced('other-future-model'), 'arun_other_model');
		const calculated = priced('gpt-5.6-sol');
		expect(JSON.parse(calculated).pricing.status).toBe('calculated');
		run('gpt-5.6-sol', calculated, 'arun_builtin');
		t.sqlite
			.prepare(
				`INSERT INTO user_model_rate (id,user_id,model,version,input_rate,cache_read_rate,cache_write_rate,output_rate,created_at) VALUES (?,?,?,?,?,?,?,?,?)`
			)
			.run('umr_r', USER, 'future-model', 1, '3', '0.3', null, '9', createdAt + 50);

		const before = { other: usageOf('arun_other_model'), builtin: usageOf('arun_builtin') };
		const result = await repriceUnpricedRuns(t.db, t.env, USER, 'future-model', createdAt + 100);

		expect(result).toEqual({ repriced: 1, still_unpriced: 0, remaining: 0 });
		const after = JSON.parse(usageOf('arun_target')) as AgentRunUsage;
		expect(after.pricing).toMatchObject({
			status: 'calculated',
			basis: { plan: 'user_entered', rate_source: 'user', rate_id: 'user-rate:umr_r' },
			repriced_from: { reason: 'unsupported_model' }
		});
		expect(usageOf('arun_other_model')).toBe(before.other);
		expect(usageOf('arun_builtin')).toBe(before.builtin);

		// A second pass finds nothing left and writes nothing.
		const repriced = usageOf('arun_target');
		expect(await repriceUnpricedRuns(t.db, t.env, USER, 'future-model', createdAt + 200)).toEqual({
			repriced: 0,
			still_unpriced: 0,
			remaining: 0
		});
		expect(usageOf('arun_target')).toBe(repriced);
	});

	it('leaves runs unpriced and counts them when there is no user rate', async () => {
		const { t, run, usageOf } = setup();
		const unpriced = priced('future-model');
		run('future-model', unpriced, 'arun_a');
		expect(await repriceUnpricedRuns(t.db, t.env, USER, 'future-model', createdAt + 100)).toEqual({
			repriced: 0,
			still_unpriced: 1,
			remaining: 1
		});
		expect(usageOf('arun_a')).toBe(unpriced);
	});
});
