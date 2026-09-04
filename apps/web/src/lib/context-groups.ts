import type { ContextItem, Workflow, WorkflowState } from '@tines/shared';

/** One state's context items, inside a workflow group. */
export interface StateGroup {
	stateId: string;
	/** Enough for `StateBadge`; category falls back to `active` for unknown states. */
	state: Pick<WorkflowState, 'name' | 'category'>;
	items: ContextItem[];
}

/** All of one workflow's state-scoped context, ready to render as an accordion row. */
export interface WorkflowGroup {
	/** `''` when the scope carries no workflow id (defensive; a state always has one). */
	workflowId: string;
	workflowName: string;
	states: StateGroup[];
	itemCount: number;
}

/**
 * Group project ∧ state context items by workflow, in a stable display order:
 * workflows alphabetically, states in the workflow's own position order, items
 * by name. The server returns context `updated_at DESC`, which interleaves
 * workflows and reshuffles on every write — the order has to be imposed here.
 * Project-only items are ignored (they render expanded above the accordion).
 */
export function groupContextByWorkflow(
	items: ContextItem[],
	workflows: Pick<Workflow, 'id' | 'states'>[]
): WorkflowGroup[] {
	const groups = new Map<string, { group: WorkflowGroup; byState: Map<string, StateGroup> }>();

	for (const item of items) {
		const stateId = item.scope.workflow_state_id;
		if (!stateId) continue;
		const workflowId = item.scope.workflow_id ?? '';

		let entry = groups.get(workflowId);
		if (!entry) {
			entry = {
				group: {
					workflowId,
					workflowName: item.scope.workflow_name ?? 'Other workflow',
					states: [],
					itemCount: 0
				},
				byState: new Map()
			};
			groups.set(workflowId, entry);
		}

		let stateGroup = entry.byState.get(stateId);
		if (!stateGroup) {
			const state = workflows
				.find((w) => w.id === workflowId)
				?.states.find((s) => s.id === stateId);
			stateGroup = {
				stateId,
				state: {
					name: item.scope.workflow_state_name ?? state?.name ?? '—',
					category: state?.category ?? 'active'
				},
				items: []
			};
			entry.byState.set(stateId, stateGroup);
			entry.group.states.push(stateGroup);
		}
		stateGroup.items.push(item);
		entry.group.itemCount++;
	}

	for (const { group, byState } of groups.values()) {
		// States a workflow no longer lists (or that predate it) sort last, by name.
		const positions = new Map(
			(workflows.find((w) => w.id === group.workflowId)?.states ?? []).map((s) => [
				s.id,
				s.position
			])
		);
		const position = (sg: StateGroup) => positions.get(sg.stateId) ?? Infinity;
		group.states.sort((a, b) => {
			// `Infinity - Infinity` is NaN, so compare before subtracting.
			const [pa, pb] = [position(a), position(b)];
			return pa === pb ? a.state.name.localeCompare(b.state.name) : pa - pb;
		});
		for (const sg of byState.values()) sg.items.sort((a, b) => a.name.localeCompare(b.name));
	}

	return [...groups.values()]
		.map((e) => e.group)
		.sort(
			(a, b) =>
				a.workflowName.localeCompare(b.workflowName) || a.workflowId.localeCompare(b.workflowId)
		);
}
