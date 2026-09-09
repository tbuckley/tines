import {
	buildStateLibrary,
	childrenOf,
	type ContextItem,
	type LibraryWorkflow,
	type StateLibrary,
	type Workflow,
	type WorkflowState
} from '@tines/shared';

/** One end of an inheritance pointer, named the way every surface links it. */
export interface StateRef {
	stateId: string;
	stateName: string;
	workflowId: string;
	workflowName: string;
}

/** One state's context items, inside a workflow group. */
export interface StateGroup {
	stateId: string;
	/** Enough for `StateBadge`; category falls back to `active` for unknown states. */
	state: Pick<WorkflowState, 'name' | 'category'>;
	items: ContextItem[];
	/** The state this one inherits context from, or null (Tines/238). */
	inheritsFrom: StateRef | null;
	/** The states inheriting from this one, library-wide; `[]` when none. */
	inheritedBy: StateRef[];
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
 *
 * Inheritance pointers are read off `workflows`, not off the items: a base's
 * own items are state-scoped with no project, so they are never in `items`,
 * and the pointer must show even when the base has nothing on it yet.
 */
export function groupContextByWorkflow(
	items: ContextItem[],
	workflows: Pick<Workflow, 'id' | 'name' | 'states'>[]
): WorkflowGroup[] {
	// `buildStateLibrary` wants the whole workflow shape; the pointer helpers
	// only touch `states`, so fill the rest in for the callers that pass less.
	const lib = buildStateLibrary(
		workflows.map((w): LibraryWorkflow => ({
			id: w.id,
			name: w.name ?? '',
			is_system: false,
			issue_count: 0,
			states: w.states,
			transitions: []
		}))
	);
	const refOf = (l: StateLibrary, id: string): StateRef | null => {
		const entry = l.states.get(id);
		return entry
			? {
					stateId: entry.state.id,
					stateName: entry.state.name,
					workflowId: entry.workflow.id,
					workflowName: entry.workflow.name
				}
			: null;
	};
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
			const base = state?.inherits_from ?? null;
			stateGroup = {
				stateId,
				state: {
					name: item.scope.workflow_state_name ?? state?.name ?? '—',
					category: state?.category ?? 'active'
				},
				items: [],
				inheritsFrom: base === null ? null : refOf(lib, base),
				inheritedBy: childrenOf(lib, stateId).flatMap((c) => refOf(lib, c.state.id) ?? [])
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
