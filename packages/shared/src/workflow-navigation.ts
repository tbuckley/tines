export function workflowStateAnchorId(stateId: string): string {
	return `state-${stateId}`;
}

export function workflowStateHref(workflowId: string, stateId: string): string {
	const anchor = workflowStateAnchorId(stateId);
	return `/workflows/${workflowId}?state=${stateId}#${anchor}`;
}
