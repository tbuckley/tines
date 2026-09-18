import { describe, expect, it } from 'vitest';
import { effortLabel, isEffortToken, supportedEfforts } from './effort.js';

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
});
