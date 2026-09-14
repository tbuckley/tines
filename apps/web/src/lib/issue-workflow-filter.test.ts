import type { WorkflowResponse } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { issueWorkflowFilterPresentation } from './issue-workflow-filter';

const workflow = (
	id: string,
	name: string,
	states: Array<[id: string, name: string, position?: number]>
): WorkflowResponse => ({
	id,
	name,
	description: '',
	is_system: false,
	initial_state_id: states[0]?.[0] ?? '',
	states: states.map(([stateId, stateName, position], index) => ({
		id: stateId,
		name: stateName,
		category: 'active',
		position: position ?? index,
		inherits_from: null
	})),
	transitions: [],
	issue_count: 0,
	created_at: 0,
	updated_at: 0
});

const workflows = [
	workflow('wf_eng', 'Engineering', [
		['s_review_eng', 'Review', 2],
		['s_build', 'Build', 1]
	]),
	workflow('wf_support', 'Support', [
		['s_triage', 'Triage'],
		['s_review_support', 'Review']
	])
];

describe('issueWorkflowFilterPresentation', () => {
	it('resolves exact workflow and scoped state ids or names without canonicalizing refs', () => {
		const byId = issueWorkflowFilterPresentation(workflows, 'wf_eng', 's_review_eng');
		expect(byId.selectedWorkflow?.id).toBe('wf_eng');
		expect(byId.stateOptions.map((state) => state.id)).toEqual(['s_build', 's_review_eng']);
		expect(byId.stateSelectValue).toBe('s_review_eng');
		expect(byId.stateChipLabel).toBe('Review');

		const byName = issueWorkflowFilterPresentation(workflows, 'Engineering', 'Review');
		expect(byName.workflowSelectValue).toBe('wf_eng');
		expect(byName.stateSelectValue).toBe('s_review_eng');
		expect(byName.workflowChipLabel).toBe('Engineering');
	});

	it('keeps state-only and unknown refs visible but disables dependent choices', () => {
		const legacy = issueWorkflowFilterPresentation(workflows, undefined, 's_triage');
		expect(legacy.selectedWorkflow).toBeUndefined();
		expect(legacy.stateOptions).toEqual([]);
		expect(legacy.stateChipLabel).toBe('Triage');
		expect(legacy.stateSynthetic?.label).toBe('Current filter: Triage');
		expect(legacy.stateHelp).toBe('Choose a workflow first');

		const stale = issueWorkflowFilterPresentation(workflows, 'WF_ENG', 'Missing');
		expect(stale.workflowSynthetic?.label).toBe('Unavailable workflow: WF_ENG');
		expect(stale.workflowChipLabel).toBe('WF_ENG');
		expect(stale.stateChipLabel).toBe('Missing');
		expect(stale.stateHelp).toBe('Choose an available workflow first');
	});

	it('does not offer another workflow state for a mismatched current filter', () => {
		const result = issueWorkflowFilterPresentation(workflows, 'wf_eng', 's_triage');
		expect(result.stateOptions.map((state) => state.id)).toEqual(['s_build', 's_review_eng']);
		expect(result.stateSynthetic?.label).toBe('Current filter: Triage');
		expect(result.stateChipLabel).toBe('Triage');
	});

	it('keeps duplicate workflow names ambiguous and disambiguates their options', () => {
		const duplicate = workflow('wf_eng_2', 'Engineering', [['s_plan', 'Plan']]);
		const result = issueWorkflowFilterPresentation(
			[...workflows, duplicate],
			'Engineering',
			'Review'
		);
		expect(result.matchingWorkflows.map((item) => item.id)).toEqual(['wf_eng', 'wf_eng_2']);
		expect(result.selectedWorkflow).toBeUndefined();
		expect(result.workflowSynthetic?.label).toBe('Engineering (multiple workflows)');
		expect(result.workflowOptions.filter((item) => item.label.startsWith('Engineering'))).toEqual([
			{ id: 'wf_eng', label: 'Engineering (wf_eng)' },
			{ id: 'wf_eng_2', label: 'Engineering (wf_eng_2)' }
		]);
		expect(result.stateHelp).toBe('Choose one workflow first');
	});

	it('does not mutate the supplied workflow or state ordering', () => {
		const before = workflows[0].states.map((state) => state.id);
		issueWorkflowFilterPresentation(workflows, 'wf_eng', 'Review');
		expect(workflows[0].states.map((state) => state.id)).toEqual(before);
	});
});
