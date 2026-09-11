import { describe, expect, it } from 'vitest';
import { aggregateUsage, classifyUsage, resolveUsagePeriod, usageCostLabel } from './usage.js';

describe('usage accounting', () => {
	it('distinguishes priced zero, token-only zero, null and malformed records', () => {
		expect(classifyUsage({ cost_usd: 0, cost_source: 'provider' }).status).toBe('priced');
		expect(classifyUsage({ input_tokens: 0, cost_source: 'none' })).toMatchObject({
			status: 'unpriced',
			diagnostics: { explicit_none: 1, unknown_or_inconsistent_source: 1 }
		});
		expect(classifyUsage(null)).toMatchObject({
			status: 'unreported',
			diagnostics: { legacy_null: 1 }
		});
		expect(classifyUsage('{')).toMatchObject({
			status: 'unreported',
			diagnostics: { malformed: 1 }
		});
	});

	it('rejects invalid fields independently and does not coerce', () => {
		const result = classifyUsage({ cost_usd: '1.2', input_tokens: 1, output_tokens: -1 });
		expect(result.status).toBe('unpriced');
		expect(result.diagnostics.invalid_cost).toBe(1);
		expect(result.diagnostics.invalid_token_fields).toBe(1);
		expect(result.diagnostics.partial_token_fields).toBe(1);
	});

	it('sums exact decimal spellings and calculates nearest-rank distribution', () => {
		const values = [
			{ cost_usd: 0.1, cost_source: 'provider' },
			{ cost_usd: 0.2, cost_source: 'provider' },
			{ input_tokens: 2 },
			null
		];
		const total = aggregateUsage(values);
		expect(total.cost_usd_exact).toBe('0.3');
		expect(total).toMatchObject({
			finalized_run_count: 4,
			priced_run_count: 2,
			unpriced_run_count: 1,
			unreported_run_count: 1,
			coverage: 'partial'
		});
		expect(total.distribution).toMatchObject({
			sample_count: 2,
			missing_price_count: 2,
			mean_cost_usd: 0.15,
			p95_cost_usd: 0.2,
			max_cost_usd: 0.2,
			low_sample: true
		});
		expect(total.distribution.median_cost_usd).toBeCloseTo(0.15);
	});

	it('keeps a large outlier visible when p95 remains cheap', () => {
		const total = aggregateUsage([
			...Array.from({ length: 100 }, () => ({ cost_usd: 0.01, cost_source: 'provider' })),
			{ cost_usd: 100, cost_source: 'provider' }
		]);
		expect(total.cost_usd_exact).toBe('101');
		expect(total.distribution).toMatchObject({
			sample_count: 101,
			mean_cost_usd: 1,
			median_cost_usd: 0.01,
			p95_cost_usd: 0.01,
			max_cost_usd: 100,
			low_sample: false
		});
	});

	it('renders zero, sub-cent, missing, and empty honestly', () => {
		expect(usageCostLabel(0)).toBe('$0');
		expect(usageCostLabel(0.001)).toBe('<$0.01');
		expect(usageCostLabel(null)).toBe('Unknown');
		expect(usageCostLabel(null, 0)).toBe('No runs');
	});
});

describe('usage periods', () => {
	it('uses supervisor timezone for Today across DST', () => {
		const now = Date.parse('2026-03-08T16:00:00Z');
		expect(resolveUsagePeriod({ window: 'today' }, 'America/New_York', now)).toMatchObject({
			from: Date.parse('2026-03-08T05:00:00Z'),
			to: now,
			timezone: 'America/New_York',
			timezone_source: 'supervisor_budget'
		});
	});

	it('uses exact rolling hours and falls back to UTC', () => {
		const now = Date.parse('2026-03-08T16:00:00Z');
		const result = resolveUsagePeriod({ window: '7d' }, 'Not/AZone', now);
		expect(result.from).toBe(now - 168 * 3_600_000);
		expect(result.timezone_source).toBe('utc_fallback');
	});

	it('rejects partial, future, offset-less and rollover bounds', () => {
		const now = Date.parse('2026-09-11T12:00:00Z');
		expect(() => resolveUsagePeriod({ from: '2026-01-01' }, 'UTC', now)).toThrow(
			'required together'
		);
		expect(() =>
			resolveUsagePeriod({ from: '2026-02-30', to: '2026-03-02' }, 'UTC', now)
		).toThrow();
		expect(() =>
			resolveUsagePeriod({ from: '2026-01-01T00:00', to: '2026-01-02' }, 'UTC', now)
		).toThrow('explicit offset');
		expect(() => resolveUsagePeriod({ from: '2026-09-11', to: '2026-09-12' }, 'UTC', now)).toThrow(
			'future'
		);
	});
});
