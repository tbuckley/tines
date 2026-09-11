import type { UsageGroup } from '@tines/shared';

export function sortUsageGroups(groups: UsageGroup[], direction: 'asc' | 'desc'): UsageGroup[] {
	return [...groups].sort((a, b) => {
		const ac = a.aggregate.cost_usd,
			bc = b.aggregate.cost_usd;
		if (ac === null && bc !== null) return 1;
		if (ac !== null && bc === null) return -1;
		if (ac !== null && bc !== null && ac !== bc) return direction === 'asc' ? ac - bc : bc - ac;
		return a.key.localeCompare(b.key);
	});
}
