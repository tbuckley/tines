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
	it('prices an all-short request proof whose cumulative total exceeds 272k', () => {
		const raw = {
			input_tokens: 300_000,
			cached_input_tokens: 210_000,
			cache_write_input_tokens: 10_000,
			output_tokens: 3_000
		};
		const result = price(
			{
				input_tokens: 80_000,
				cache_read_tokens: 210_000,
				cache_write_tokens: 10_000,
				output_tokens: 3_000
			},
			evidence({
				raw_usage: raw,
				request_context: {
					version: 1,
					normalization: 'codex-rollout-delta-v1',
					harness_version: '0.153.4',
					status: 'complete',
					request_count: 2,
					max_request_input_tokens: 150_000,
					reconciled_usage: raw
				}
			})
		);
		expect(result.pricing).toMatchObject({
			status: 'calculated',
			basis: { cost_usd_exact: '0.514' }
		});
	});

	it.each([
		['0.154.0', 'calculated'],
		['1.0.0', 'calculated'],
		['0.153.3', 'unpriced'],
		['0.154.0-rc.1', 'unpriced']
	] as const)('accepts a request proof only from Codex %s or newer', (version, status) => {
		const raw = {
			input_tokens: 300_000,
			cached_input_tokens: 210_000,
			cache_write_input_tokens: 10_000,
			output_tokens: 3_000
		};
		const result = price(
			{
				input_tokens: 80_000,
				cache_read_tokens: 210_000,
				cache_write_tokens: 10_000,
				output_tokens: 3_000
			},
			evidence({
				raw_usage: raw,
				request_context: {
					version: 1,
					normalization: 'codex-rollout-delta-v1',
					harness_version: version,
					status: 'complete',
					request_count: 2,
					max_request_input_tokens: 150_000,
					reconciled_usage: raw
				}
			})
		);
		expect(result.pricing).toMatchObject(
			status === 'calculated' ? { status } : { status, reason: 'request_context_invalid' }
		);
	});

	it.each([
		[272_001, 'long_context_rate_unsupported'],
		[150_000, 'request_context_invalid']
	] as const)('rejects an unusable request proof (%s)', (max, reason) => {
		const raw = {
			input_tokens: 300_000,
			cached_input_tokens: 0,
			cache_write_input_tokens: 0,
			output_tokens: 0
		};
		const proof =
			max === 150_000
				? {
						version: 1 as const,
						normalization: 'codex-rollout-delta-v1' as const,
						status: 'invalid' as const,
						reason: 'delta_mismatch' as const
					}
				: {
						version: 1 as const,
						normalization: 'codex-rollout-delta-v1' as const,
						harness_version: '0.153.4' as const,
						status: 'complete' as const,
						request_count: 2,
						max_request_input_tokens: max,
						reconciled_usage: raw
					};
		expect(
			price(
				{ input_tokens: 300_000, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 },
				evidence({ raw_usage: raw, request_context: proof })
			).pricing
		).toMatchObject({ status: 'unpriced', reason });
	});

	it('ignores additive proof failures for published-band catalog rows', () => {
		const publishedEvidence = evidence({
			model: 'gpt-5.3-codex',
			raw_usage: {
				input_tokens: 1000,
				cached_input_tokens: 600,
				cache_write_input_tokens: 0,
				output_tokens: 100
			},
			request_context: {
				version: 1,
				normalization: 'codex-rollout-delta-v1',
				status: 'invalid',
				reason: 'malformed'
			}
		});
		expect(
			price(
				{ input_tokens: 400, cache_read_tokens: 600, cache_write_tokens: 0, output_tokens: 100 },
				publishedEvidence,
				{ model: 'gpt-5.3-codex', created_at }
			).pricing
		).toMatchObject({ status: 'calculated', basis: { context_band: 'published' } });
	});
	it('pins every supported exact model and all four reviewed rate dimensions', () => {
		expect(
			CODEX_RATES.map(({ model, context_band, rates }) => ({ model, context_band, rates }))
		).toEqual([
			{
				model: 'gpt-6-astra',
				context_band: 'short',
				rates: {
					input_tokens: '10',
					cache_read_tokens: '1',
					cache_write_tokens: '12.5',
					output_tokens: '50'
				}
			},
			{
				model: 'gpt-5.6-sol',
				context_band: 'short',
				rates: {
					input_tokens: '4',
					cache_read_tokens: '0.4',
					cache_write_tokens: '5',
					output_tokens: '20'
				}
			},
			{
				model: 'gpt-5.6-terra',
				context_band: 'short',
				rates: {
					input_tokens: '2',
					cache_read_tokens: '0.2',
					cache_write_tokens: '2.5',
					output_tokens: '12'
				}
			},
			{
				model: 'gpt-5.6-luna',
				context_band: 'short',
				rates: {
					input_tokens: '0.2',
					cache_read_tokens: '0.02',
					cache_write_tokens: '0.25',
					output_tokens: '1.2'
				}
			},
			{
				model: 'gpt-5-codex',
				context_band: 'published',
				rates: {
					input_tokens: '1.25',
					cache_read_tokens: '0.125',
					cache_write_tokens: null,
					output_tokens: '10'
				}
			},
			{
				model: 'gpt-5.1-codex',
				context_band: 'published',
				rates: {
					input_tokens: '1.25',
					cache_read_tokens: '0.125',
					cache_write_tokens: null,
					output_tokens: '10'
				}
			},
			{
				model: 'gpt-5.1-codex-max',
				context_band: 'published',
				rates: {
					input_tokens: '1.25',
					cache_read_tokens: '0.125',
					cache_write_tokens: null,
					output_tokens: '10'
				}
			},
			{
				model: 'gpt-5.1-codex-mini',
				context_band: 'published',
				rates: {
					input_tokens: '0.25',
					cache_read_tokens: '0.025',
					cache_write_tokens: null,
					output_tokens: '2'
				}
			},
			{
				model: 'gpt-5.2-codex',
				context_band: 'published',
				rates: {
					input_tokens: '1.75',
					cache_read_tokens: '0.175',
					cache_write_tokens: null,
					output_tokens: '14'
				}
			},
			{
				model: 'gpt-5.3-codex',
				context_band: 'published',
				rates: {
					input_tokens: '1.75',
					cache_read_tokens: '0.175',
					cache_write_tokens: null,
					output_tokens: '14'
				}
			},
			{
				model: 'codex-mini-latest',
				context_band: 'published',
				rates: {
					input_tokens: '1.5',
					cache_read_tokens: '0.375',
					cache_write_tokens: null,
					output_tokens: '6'
				}
			}
		]);
	});

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

	it('does not price a linked resumed run even if the producer claims a cold session', () => {
		expect(
			price(usage, evidence(), {
				model: 'gpt-5.6-sol',
				created_at,
				resumed_from_run_id: 'arun_previous'
			}).pricing
		).toMatchObject({ status: 'unpriced', reason: 'attempt_scope_unknown' });
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
