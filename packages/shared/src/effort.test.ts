import { describe, expect, it } from 'vitest';
import { admitEffort, effortLabel, isEffortToken, supportedEfforts } from './effort.js';

describe('effort contract', () => {
	it('accepts bounded lowercase tokens without coercing provider vocabulary', () => {
		expect(['low', 'xhigh', 'ultra', 'provider_1'].every(isEffortToken)).toBe(true);
		expect(['', 'High', '-low', 'a'.repeat(33)].some(isEffortToken)).toBe(false);
	});

	it('requires an exact model capability match', () => {
		const capabilities = {
			version: 1 as const,
			daemon_version: '1',
			harness: 'codex' as const,
			harness_version: '1',
			catalog_digest: 'x',
			models: [{ model: 'gpt-5.6', efforts: ['low', 'ultra'] }]
		};
		expect(supportedEfforts(capabilities, 'gpt-5.6')).toEqual(['low', 'ultra']);
		expect(supportedEfforts(capabilities, 'gpt-5.6-mini')).toBeNull();
		expect(effortLabel(null)).toBe('provider default');
	});

	it.each([
		[['low', 'high'], 'low', false, { ok: true, verification: 'verified' }],
		[['low', 'high'], 'ultra', true, { ok: false, reason: 'unsupported_effort: allows low, high' }],
		[null, 'high', true, { ok: true, verification: 'asserted' }],
		[
			null,
			'high',
			false,
			{
				ok: false,
				reason: 'daemon_upgrade_required: this daemon cannot accept effort for unlisted models'
			}
		],
		[
			null,
			'bogus',
			true,
			{ ok: false, reason: 'capability_unavailable: exact model support was not reported' }
		]
	] as const)('admits listed and asserted efforts', (allowed, value, assertable, expected) => {
		expect(admitEffort(allowed, value, assertable)).toMatchObject(expected);
	});
});
