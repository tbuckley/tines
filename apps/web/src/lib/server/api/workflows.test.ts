import { describe, expect, it } from 'vitest';
import type { WorkflowStateInput, WorkflowTransitionInput } from '@tines/shared';
import { ApiFail } from './core';
import { deadEndWarnings, resolveDef } from './workflows';

const states: WorkflowStateInput[] = [
	{ name: 'Open', category: 'active' },
	{ name: 'Review', category: 'awaiting_human' },
	{ name: 'Closed', category: 'done' }
];
const transitions: WorkflowTransitionInput[] = [
	{ name: 'Submit', from: 'Open', to: 'Review' },
	{ name: 'Send back', from: 'Review', to: 'Open' },
	{ name: 'Approve', from: 'Review', to: 'Closed' }
];

function failCode(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		if (e instanceof ApiFail) return e.code;
		throw e;
	}
	throw new Error('expected resolveDef to throw');
}

describe('resolveDef', () => {
	it('resolves a valid definition, assigning ids and positions', () => {
		const def = resolveDef(states, transitions, 'Open', []);
		expect(def.states).toHaveLength(3);
		expect(def.states.map((s) => s.position)).toEqual([0, 1, 2]);
		expect(def.states.every((s) => s.isNew && s.id.startsWith('wfs_'))).toBe(true);
		expect(def.initialStateId).toBe(def.states[0].id);
		expect(def.transitions).toHaveLength(3);
		const byName = new Map(def.states.map((s) => [s.name, s.id]));
		expect(def.transitions[0]).toMatchObject({
			name: 'Submit',
			from_state_id: byName.get('Open'),
			to_state_id: byName.get('Review')
		});
	});

	it('resolves transition and initial refs by existing state id', () => {
		const existing = [{ id: 'wfs_x1', name: 'Open', category: 'active' as const }];
		const def = resolveDef(
			[
				{ id: 'wfs_x1', name: 'Renamed', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			[{ name: 'Finish', from: 'wfs_x1', to: 'Done' }],
			'wfs_x1',
			existing
		);
		expect(def.initialStateId).toBe('wfs_x1');
		expect(def.states[0]).toMatchObject({ id: 'wfs_x1', name: 'Renamed', isNew: false });
		expect(def.transitions[0].from_state_id).toBe('wfs_x1');
	});

	it('rejects an empty state list', () => {
		expect(failCode(() => resolveDef([], [], 'Open', []))).toBe('no_states');
	});

	it('rejects an invalid category', () => {
		const bad = [{ name: 'Open', category: 'bogus' as never }];
		expect(failCode(() => resolveDef(bad, [], 'Open', []))).toBe('invalid_category');
	});

	it('rejects duplicate state names', () => {
		const dup = [
			{ name: 'Open', category: 'active' as const },
			{ name: 'Open', category: 'done' as const }
		];
		expect(failCode(() => resolveDef(dup, [], 'Open', []))).toBe('duplicate_state_name');
	});

	it('rejects state ids that are not part of the workflow', () => {
		const foreign = [{ id: 'wfs_other', name: 'Open', category: 'active' as const }];
		expect(failCode(() => resolveDef(foreign, [], 'Open', []))).toBe('unknown_state');
	});

	it('rejects an initial state categorized done or awaiting_human', () => {
		const done = [{ name: 'Closed', category: 'done' as const }];
		expect(failCode(() => resolveDef(done, [], 'Closed', []))).toBe('invalid_initial_state');
	});

	it('rejects transitions referencing unknown states', () => {
		expect(
			failCode(() => resolveDef(states, [{ name: 'X', from: 'Open', to: 'Nowhere' }], 'Open', []))
		).toBe('unknown_state');
	});

	it('rejects self-transitions', () => {
		expect(
			failCode(() => resolveDef(states, [{ name: 'Loop', from: 'Open', to: 'Open' }], 'Open', []))
		).toBe('self_transition');
	});

	it('rejects duplicate (from, to) pairs', () => {
		const dup = [
			{ name: 'A', from: 'Open', to: 'Review' },
			{ name: 'B', from: 'Open', to: 'Review' }
		];
		expect(failCode(() => resolveDef(states, dup, 'Open', []))).toBe('duplicate_transition');
	});

	it('rejects two same-named actions out of one state (case-insensitive)', () => {
		const dup = [
			{ name: 'reject', from: 'Review', to: 'Open' },
			{ name: 'Reject', from: 'Review', to: 'Closed' }
		];
		expect(failCode(() => resolveDef(states, dup, 'Open', []))).toBe('duplicate_action');
	});

	it('allows the same action name out of two different states', () => {
		const ok = [
			{ name: 'advance', from: 'Open', to: 'Review' },
			{ name: 'advance', from: 'Review', to: 'Closed' }
		];
		expect(() => resolveDef(states, ok, 'Open', [])).not.toThrow();
	});
});

describe('deadEndWarnings', () => {
	it('warns on non-done states with no way out', () => {
		const def = resolveDef(states, [{ name: 'Submit', from: 'Open', to: 'Review' }], 'Open', []);
		const warnings = deadEndWarnings(def);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"Review"');
	});

	it('is quiet when every non-done state has an exit', () => {
		const def = resolveDef(states, transitions, 'Open', []);
		expect(deadEndWarnings(def)).toEqual([]);
	});
});
