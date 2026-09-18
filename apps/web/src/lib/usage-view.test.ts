import { describe, expect, it } from 'vitest';
import { aggregateUsage, type UsageGroup } from '@tines/shared';
import { sortUsageGroups } from './usage-view';

const group = (key: string, values: unknown[]): UsageGroup => ({
	key,
	dimension: { id: key, name: key },
	aggregate: aggregateUsage(values)
});

describe('spend group sorting', () => {
	it('sorts cost both ways while keeping unknown last and ties stable', () => {
		const groups = [
			group('unknown', [null]),
			group('b', [{ cost_usd: 2 }]),
			group('a', [{ cost_usd: 2 }]),
			group('zero', [{ cost_usd: 0 }])
		];
		expect(sortUsageGroups(groups, 'desc').map((g) => g.key)).toEqual([
			'a',
			'b',
			'zero',
			'unknown'
		]);
		expect(sortUsageGroups(groups, 'asc').map((g) => g.key)).toEqual(['zero', 'a', 'b', 'unknown']);
	});
});
