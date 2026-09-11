import { describe, expect, it } from 'vitest';
import type { AgentRunUsage, CodexPricingEvidenceV1 } from '@tines/shared';
import { CODEX_RATES, priceCodexUsage, type CodexRate } from './codex-pricing';

const created_at = Date.parse('2026-09-11T03:30:00Z');
const evidence = (overrides: Partial<CodexPricingEvidenceV1> = {}): CodexPricingEvidenceV1 => ({
	version: 1,
	harness: 'codex',
	model: 'gpt-5.6-sol',
	identity_source: 'launch_argument',
	usage_scope: 'thread_total',
	session_mode: 'cold',
	normalization: 'codex-jsonl-v1',
	raw_usage: {
		input_tokens: 1000,
		cached_input_tokens: 600,
		cache_write_input_tokens: 100,
		output_tokens: 100
	},
	model_rerouted: false,
	measurement_status: 'complete',
	terminal_snapshots: 1,
	...overrides
});
const usage: AgentRunUsage = {
	input_tokens: 300,
	cache_read_tokens: 600,
	cache_write_tokens: 100,
	output_tokens: 100
};
const price = (
	u = usage,
	e = evidence(),
	run: { model: string | null; created_at: number; resumed_from_run_id?: string | null } = {
		model: 'gpt-5.6-sol',
		created_at
	},
	catalog = CODEX_RATES
) => priceCodexUsage({ run, usage: u, evidence: e, now: created_at + 1000 }, catalog);

describe('priceCodexUsage', () => {
	it('prices the four non-overlapping Sol classes exactly and persists the rate basis', () => {
		const result = price();
		expect(result).toMatchObject({
			cost_usd: 0.00394,
			cost_source: 'priced',
			pricing: {
				status: 'calculated',
				basis: {
					cost_usd_exact: '0.00394',
					rate_id: 'openai-api-standard:gpt-5.6-sol:2026-09-11:v1'
				}
			}
		});
	});

	it('preserves measured zero and tiny positive values', () => {
		const zeroRaw = {
			input_tokens: 0,
			cached_input_tokens: 0,
			cache_write_input_tokens: 0,
			output_tokens: 0
		};
		expect(
			price(
				{ input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 },
				evidence({ raw_usage: zeroRaw })
			).cost_usd
		).toBe(0);
		const tiny = price(
			{ input_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 },
			evidence({ raw_usage: { ...zeroRaw, input_tokens: 1 } })
		);
		expect(tiny.pricing?.status === 'calculated' && tiny.pricing.basis.cost_usd_exact).toBe(
			'0.000004'
		);
	});

	it.each([
		['model_mismatch', evidence({ model: 'gpt-6-astra' }), { model: 'gpt-5.6-sol', created_at }],
		['model_rerouted', evidence({ model_rerouted: true }), { model: 'gpt-5.6-sol', created_at }],
		[
			'attempt_scope_unknown',
			evidence({ session_mode: 'resumed' }),
			{ model: 'gpt-5.6-sol', created_at }
		],
		[
			'unsupported_model',
			evidence({ model: 'future-model' }),
			{ model: 'future-model', created_at }
		],
		['missing_rate', evidence(), { model: 'gpt-5.6-sol', created_at: created_at - 1 }],
		[
			'long_context_band_unknown',
			evidence({
				raw_usage: {
					input_tokens: 272001,
					cached_input_tokens: 0,
					cache_write_input_tokens: 0,
					output_tokens: 0
				}
			}),
			{ model: 'gpt-5.6-sol', created_at }
		]
	] as const)('keeps %s honestly unpriced', (reason, e, run) => {
		const raw = e.raw_usage!;
		const operands = {
			input_tokens: raw.input_tokens! - raw.cached_input_tokens! - raw.cache_write_input_tokens!,
			cache_read_tokens: raw.cached_input_tokens!,
			cache_write_tokens: raw.cache_write_input_tokens!,
			output_tokens: raw.output_tokens!
		};
		expect(price(operands, e, run).pricing).toMatchObject({ status: 'unpriced', reason });
	});

	it('requires explicit zero for an unpublished cache-write rate', () => {
		const e = evidence({
			model: 'gpt-5-codex',
			raw_usage: {
				input_tokens: 10,
				cached_input_tokens: 1,
				cache_write_input_tokens: 1,
				output_tokens: 1
			}
		});
		expect(
			price({ input_tokens: 8, cache_read_tokens: 1, cache_write_tokens: 1, output_tokens: 1 }, e, {
				model: 'gpt-5-codex',
				created_at
			}).pricing
		).toMatchObject({ reason: 'missing_rate' });
	});

	it('keeps provider dollars authoritative and legacy priced dollars unchanged', () => {
		expect(price({ ...usage, cost_usd: 0, cost_source: 'provider' }).pricing?.status).toBe(
			'provider_authoritative'
		);
		const legacy = { ...usage, cost_usd: 2, cost_source: 'priced' as const };
		expect(
			priceCodexUsage({ run: { model: null, created_at }, usage: legacy, now: created_at })
		).toEqual(legacy);
	});

	it('selects the claim-time version and leaves stored basis independent of later catalog changes', () => {
		const next: CodexRate = {
			...CODEX_RATES.find((r) => r.model === 'gpt-5.6-sol')!,
			id: 'next',
			version: 2,
			adopted_at: created_at + 10,
			rates: {
				input_tokens: '8',
				cache_read_tokens: '0.8',
				cache_write_tokens: '10',
				output_tokens: '40'
			}
		};
		const before = price(usage, evidence(), { model: 'gpt-5.6-sol', created_at: created_at + 5 }, [
			...CODEX_RATES,
			next
		]);
		expect(before.pricing?.status === 'calculated' && before.pricing.basis.rate_valid_to).toBe(
			created_at + 10
		);
		const persisted = JSON.parse(JSON.stringify(before));
		expect(persisted.pricing.basis.cost_usd_exact).toBe('0.00394');
	});
});
