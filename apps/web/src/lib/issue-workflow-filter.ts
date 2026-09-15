import type { WorkflowResponse, WorkflowState } from '@tines/shared';

export interface IssueWorkflowOption {
	id: string;
	label: string;
}

export interface IssueWorkflowFilterPresentation {
	workflowOptions: IssueWorkflowOption[];
	matchingWorkflows: WorkflowResponse[];
	selectedWorkflow?: WorkflowResponse;
	workflowSelectValue: string;
	workflowSynthetic?: IssueWorkflowOption;
	workflowChipLabel?: string;
	stateOptions: WorkflowState[];
	stateSelectValue: string;
	stateSynthetic?: IssueWorkflowOption;
	stateChipLabel?: string;
	stateHelp: string;
}

function unusedValue(prefix: string, used: Set<string>): string {
	let value = prefix;
	let suffix = 1;
	while (used.has(value)) value = `${prefix}-${suffix++}`;
	return value;
}

/**
 * Resolves URL-backed workflow/state refs for the filter controls without
 * changing the refs themselves. Matching is deliberately exact, like the
 * issue query: old name refs work, while new control choices can emit ids.
 */
export function issueWorkflowFilterPresentation(
	workflows: WorkflowResponse[],
	workflowRef?: string,
	stateRef?: string
): IssueWorkflowFilterPresentation {
	const duplicateNames = new Set(
		workflows
			.map((workflow) => workflow.name)
			.filter((name, index, names) => names.indexOf(name) !== names.lastIndexOf(name))
	);
	const workflowOptions = workflows.map((workflow) => ({
		id: workflow.id,
		label: duplicateNames.has(workflow.name) ? `${workflow.name} (${workflow.id})` : workflow.name
	}));
	const matchingWorkflows = workflowRef
		? workflows.filter((workflow) => workflow.id === workflowRef || workflow.name === workflowRef)
		: [];
	const selectedWorkflow = matchingWorkflows.length === 1 ? matchingWorkflows[0] : undefined;
	const usedValues = new Set([
		'',
		...workflows.map((workflow) => workflow.id),
		...workflows.flatMap((workflow) => workflow.states.map((state) => state.id))
	]);

	let workflowSynthetic: IssueWorkflowOption | undefined;
	if (workflowRef && !selectedWorkflow) {
		workflowSynthetic = {
			id: unusedValue('__current-workflow', usedValues),
			label:
				matchingWorkflows.length > 1
					? `${workflowRef} (multiple workflows)`
					: `Unavailable workflow: ${workflowRef}`
		};
		usedValues.add(workflowSynthetic.id);
	}

	const stateOptions = selectedWorkflow
		? [...selectedWorkflow.states].sort((a, b) => a.position - b.position)
		: [];
	const selectedState = stateRef
		? stateOptions.find((state) => state.id === stateRef || state.name === stateRef)
		: undefined;
	let stateSynthetic: IssueWorkflowOption | undefined;
	if (stateRef && !selectedState) {
		const acrossLibrary = workflows
			.flatMap((workflow) => workflow.states)
			.find((state) => state.id === stateRef);
		stateSynthetic = {
			id: unusedValue('__current-state', usedValues),
			label: `Current filter: ${acrossLibrary?.name ?? stateRef}`
		};
	}

	return {
		workflowOptions,
		matchingWorkflows,
		selectedWorkflow,
		workflowSelectValue: selectedWorkflow?.id ?? workflowSynthetic?.id ?? '',
		workflowSynthetic,
		workflowChipLabel: selectedWorkflow?.name ?? workflowRef,
		stateOptions,
		stateSelectValue: selectedState?.id ?? stateSynthetic?.id ?? '',
		stateSynthetic,
		stateChipLabel:
			selectedState?.name ??
			(stateRef
				? (workflows.flatMap((workflow) => workflow.states).find((state) => state.id === stateRef)
						?.name ?? stateRef)
				: undefined),
		stateHelp: selectedWorkflow
			? ''
			: !workflowRef
				? 'Choose a workflow first'
				: matchingWorkflows.length > 1
					? 'Choose one workflow first'
					: 'Choose an available workflow first'
	};
}
