import { describe, expect, it } from 'vitest';
import {
	INHERIT_RUNNER_ID,
	isGlobalRoutingScope,
	isTierOnlyTargets,
	routingScopeSpecificity
} from './routing.js';

describe('routing helpers', () => {
	it('assigns all eight scope ranks', () => {
		for (let rank = 0; rank < 8; rank++) {
			expect(
				routingScopeSpecificity({
					label_id: rank & 4 ? 'l' : null,
					project_id: rank & 2 ? 'p' : null,
					workflow_state_id: rank & 1 ? 's' : null
				})
			).toBe(rank);
		}
	});

	it('recognizes only a singleton wildcard with an explicit valid tier', () => {
		expect(isTierOnlyTargets([{ runner_id: INHERIT_RUNNER_ID, tier: 'smartest' }])).toBe(true);
		expect(isTierOnlyTargets([{ runner_id: INHERIT_RUNNER_ID }])).toBe(false);
		expect(
			isTierOnlyTargets([{ runner_id: INHERIT_RUNNER_ID, tier: 'smartest' }, { runner_id: 'r1' }])
		).toBe(false);
	});

	it('recognizes only the empty scope as global', () => {
		expect(isGlobalRoutingScope({})).toBe(true);
		expect(isGlobalRoutingScope({ project_id: 'p' })).toBe(false);
	});
});
