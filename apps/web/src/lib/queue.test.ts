import { describe, expect, it } from 'vitest';
import type { QueueGroup } from '@tines/shared';
import { waitingCountsByState } from './queue';

function group(patch: Partial<QueueGroup> & Pick<QueueGroup, 'state_id' | 'count'>): QueueGroup {
	return {
		state_name: 'Implementation',
		workflow_id: 'wfl_1',
		workflow_name: 'Engineering',
		verdict: 'at_capacity',
		detail: 'at max_concurrent (3/3)',
		runner_id: 'rnr_1',
		runner_name: 'macbook-claude',
		rule_id: null,
		ambiguous_rule_ids: [],
		binding: null,
		oldest_entered_at: 0,
		issues: [],
		...patch
	};
}

describe('waitingCountsByState', () => {
	it('sums every group that shares a state, not just the last one', () => {
		const counts = waitingCountsByState([
			group({ state_id: 'wfs_impl', count: 3, verdict: 'at_capacity', runner_id: 'rnr_1' }),
			group({ state_id: 'wfs_impl', count: 2, verdict: 'offline', runner_id: 'rnr_2' }),
			group({ state_id: 'wfs_review', count: 1 })
		]);
		// The roster limit this prefills must cover both groups: 2 alone (the last
		// entry per key) would under-provision the state it was invoked for.
		expect(counts).toEqual({ wfs_impl: 5, wfs_review: 1 });
	});

	it('is empty for an empty queue', () => {
		expect(waitingCountsByState([])).toEqual({});
	});
});
