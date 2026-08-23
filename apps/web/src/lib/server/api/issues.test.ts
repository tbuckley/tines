import type { WorkflowResponse } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { ApiFail } from './core';
import { allowedTransitions, resolveStateRef } from './issues';

const workflow: WorkflowResponse = {
	id: 'wf_1',
	name: 'Standard',
	description: '',
	is_system: true,
	initial_state_id: 's_open',
	states: [
		{ id: 's_open', name: 'Open', category: 'active', position: 0 },
		{ id: 's_review', name: 'Review', category: 'awaiting_human', position: 1 },
		{ id: 's_closed', name: 'Closed', category: 'done', position: 2 }
	],
	transitions: [
		{ id: 't_submit', name: 'Submit', from_state_id: 's_open', to_state_id: 's_review' },
		{ id: 't_back', name: 'Send back', from_state_id: 's_review', to_state_id: 's_open' },
		{ id: 't_approve', name: 'Approve', from_state_id: 's_review', to_state_id: 's_closed' },
		{ id: 't_ghost', name: 'Ghost', from_state_id: 's_open', to_state_id: 's_missing' }
	],
	issue_count: 0,
	created_at: 0,
	updated_at: 0
};

describe('allowedTransitions', () => {
	it('lists only transitions leaving the given state, with target state data', () => {
		const allowed = allowedTransitions(workflow, 's_review');
		expect(allowed.map((t) => t.name).sort()).toEqual(['Approve', 'Send back']);
		const approve = allowed.find((t) => t.name === 'Approve')!;
		expect(approve.transition_id).toBe('t_approve');
		expect(approve.to_state).toMatchObject({ id: 's_closed', category: 'done' });
	});

	it('silently drops transitions whose target state no longer exists', () => {
		const allowed = allowedTransitions(workflow, 's_open');
		expect(allowed.map((t) => t.name)).toEqual(['Submit']);
	});

	it('returns an empty list for terminal states', () => {
		expect(allowedTransitions(workflow, 's_closed')).toEqual([]);
	});
});

describe('resolveStateRef', () => {
	it('resolves by id', () => {
		expect(resolveStateRef(workflow, 's_review').name).toBe('Review');
	});

	it('resolves by name', () => {
		expect(resolveStateRef(workflow, 'Review').id).toBe('s_review');
	});

	it('throws a 422 listing the known states for an unknown reference', () => {
		let caught: unknown;
		try {
			resolveStateRef(workflow, 'Nope');
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ApiFail);
		const fail = caught as ApiFail;
		expect(fail.status).toBe(422);
		expect(fail.code).toBe('unknown_state');
		expect(fail.details?.known_states).toEqual(
			workflow.states.map((s) => ({ id: s.id, name: s.name }))
		);
	});
});
