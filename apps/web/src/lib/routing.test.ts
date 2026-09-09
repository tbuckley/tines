import { describe, expect, it } from 'vitest';
import type { RoutingRule } from '@tines/shared';
import { findGlobalRule } from './routing';

function rule(id: string, scope: Partial<RoutingRule['scope']>): RoutingRule {
	return {
		id,
		scope: { project_id: null, workflow_state_id: null, label_id: null, ...scope },
		targets: [],
		created_at: 1,
		updated_at: 1
	} as RoutingRule;
}

describe('findGlobalRule', () => {
	it('finds the rule with all three scope dimensions null', () => {
		const global = rule('rr_global', {});
		expect(findGlobalRule([rule('rr_p', { project_id: 'prj_1' }), global])).toBe(global);
	});

	it('does not mistake a single-dimension rule for the global one', () => {
		const scoped = [
			rule('rr_p', { project_id: 'prj_1' }),
			rule('rr_s', { workflow_state_id: 'wfs_1' }),
			rule('rr_l', { label_id: 'lbl_1' })
		];
		expect(findGlobalRule(scoped)).toBeNull();
		expect(findGlobalRule([])).toBeNull();
	});
});
