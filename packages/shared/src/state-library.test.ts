import { describe, expect, it } from 'vitest';
import {
	ancestorsOf,
	buildStateLibrary,
	chainLengthVia,
	childrenOf,
	isBaseLike,
	pickerGroups,
	qualifyState,
	wouldCycle,
	type LibraryWorkflow
} from './state-library.js';
import type { StateCategory, WorkflowState } from './types.js';

function state(
	id: string,
	name: string,
	category: StateCategory = 'active',
	inherits_from: string | null = null
): WorkflowState {
	return { id, name, category, position: 0, inherits_from };
}

function workflow(
	id: string,
	name: string,
	states: WorkflowState[],
	extra: Partial<LibraryWorkflow> = {}
): LibraryWorkflow {
	return { id, name, is_system: false, issue_count: 0, states, transitions: [], ...extra };
}

/** A base library (no transitions, all backlog) and two workflows using it. */
function library() {
	const shared = workflow('wf_shared', 'Shared stages', [
		state('s_merge', 'Merging', 'backlog'),
		state('s_review', 'Review', 'backlog')
	]);
	const eng = workflow(
		'wf_eng',
		'Engineering',
		[state('e_merge', 'Merging', 'active', 's_merge'), state('e_done', 'Done', 'done')],
		{
			issue_count: 2,
			transitions: [{ id: 't1', name: 'ship', from_state_id: 'e_merge', to_state_id: 'e_done' }]
		}
	);
	const docs = workflow('wf_docs', 'Docs Change', [state('d_merge', 'Merging', 'active', 's_merge')], {
		transitions: [{ id: 't2', name: 'ship', from_state_id: 'd_merge', to_state_id: 'd_merge' }]
	});
	return { shared, eng, docs, lib: buildStateLibrary([shared, eng, docs]) };
}

describe('buildStateLibrary', () => {
	it('indexes every state in library order and inverts the pointers', () => {
		const { lib } = library();
		expect([...lib.states.keys()]).toEqual(['s_merge', 's_review', 'e_merge', 'e_done', 'd_merge']);
		expect(lib.states.get('e_merge')?.workflow.name).toBe('Engineering');
		expect(childrenOf(lib, 's_merge').map((c) => c.state.id)).toEqual(['e_merge', 'd_merge']);
		expect(childrenOf(lib, 's_review')).toEqual([]);
	});
});

describe('qualifyState', () => {
	it('names a state by workflow and state', () => {
		const { lib } = library();
		expect(qualifyState(lib, 's_merge')).toBe('Shared stages / Merging');
	});

	it('falls back to the bare id for a state we cannot see', () => {
		const { lib } = library();
		expect(qualifyState(lib, 'wfs_hidden')).toBe('wfs_hidden');
	});
});

describe('ancestorsOf', () => {
	it('walks parent first, root last', () => {
		const lib = buildStateLibrary([
			workflow('wf', 'Chain', [
				state('a', 'A'),
				state('b', 'B', 'active', 'a'),
				state('c', 'C', 'active', 'b')
			])
		]);
		expect(ancestorsOf(lib, 'c')).toEqual(['b', 'a']);
		expect(ancestorsOf(lib, 'a')).toEqual([]);
	});

	it('terminates on a stored cycle', () => {
		const lib = buildStateLibrary([
			workflow('wf', 'Loop', [state('a', 'A', 'active', 'b'), state('b', 'B', 'active', 'a')])
		]);
		expect(ancestorsOf(lib, 'a')).toEqual(['b']);
	});

	it('stops at a base it cannot see', () => {
		const lib = buildStateLibrary([workflow('wf', 'W', [state('a', 'A', 'active', 'gone')])]);
		expect(ancestorsOf(lib, 'a')).toEqual(['gone']);
	});
});

describe('isBaseLike', () => {
	it('accepts a transitionless all-backlog workflow', () => {
		const { shared, eng } = library();
		expect(isBaseLike(shared)).toBe(true);
		expect(isBaseLike(eng)).toBe(false);
	});

	it('rejects an empty workflow, one non-backlog state, or any transition', () => {
		expect(isBaseLike(workflow('w', 'Empty', []))).toBe(false);
		expect(
			isBaseLike(workflow('w', 'Mixed', [state('a', 'A', 'backlog'), state('b', 'B', 'active')]))
		).toBe(false);
		expect(
			isBaseLike(
				workflow('w', 'Moves', [state('a', 'A', 'backlog')], {
					transitions: [{ id: 't', name: 'go', from_state_id: 'a', to_state_id: 'a' }]
				})
			)
		).toBe(false);
	});
});

describe('chainLengthVia and wouldCycle', () => {
	it('counts the chain a pointer would create', () => {
		const { lib } = library();
		expect(chainLengthVia(lib, 's_merge')).toBe(2);
		expect(chainLengthVia(lib, 'e_merge')).toBe(3);
	});

	it('spots self-pointing and a loop', () => {
		const { lib } = library();
		expect(wouldCycle(lib, 's_merge', 's_merge')).toBe(true);
		expect(wouldCycle(lib, 's_merge', 'e_merge')).toBe(true);
		expect(wouldCycle(lib, 'e_done', 's_merge')).toBe(false);
	});
});

describe('pickerGroups', () => {
	it('orders bases first, then the own workflow, then the rest', () => {
		const { lib } = library();
		const groups = pickerGroups(lib, { ownWorkflowId: 'wf_eng', excludeStateId: 'e_merge' });
		expect(groups.map((g) => g.workflow.name)).toEqual([
			'Shared stages',
			'Engineering',
			'Docs Change'
		]);
		expect(groups.map((g) => g.baseLike)).toEqual([true, false, false]);
		expect(groups[1].states.map((s) => s.id)).toEqual(['e_done']);
	});

	it('drops a group left empty by the exclusion', () => {
		const { lib } = library();
		const groups = pickerGroups(lib, { ownWorkflowId: 'wf_docs', excludeStateId: 'd_merge' });
		expect(groups.map((g) => g.workflow.name)).toEqual(['Shared stages', 'Engineering']);
	});

	it('offers everything when no workflow or state is named', () => {
		const { lib } = library();
		const groups = pickerGroups(lib);
		expect(groups.map((g) => g.workflow.name)).toEqual([
			'Shared stages',
			'Docs Change',
			'Engineering'
		]);
		expect(groups.flatMap((g) => g.states).length).toBe(5);
	});
});
