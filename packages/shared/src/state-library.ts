/**
 * The workflow library, indexed for state inheritance (Tines/238).
 *
 * A state's base may live in another workflow, so naming a pointer — and
 * finding the states that inherit from one — takes the whole library, not the
 * workflow in hand. Every fact these helpers derive is already carried by
 * `GET /api/v1/workflows`, so the web app and `tines workflows show` read the
 * same list through the same functions instead of computing it twice.
 */
import type { Workflow, WorkflowState } from './types.js';

/** The longest chain of inheriting states the API accepts (child → … → root). */
export const MAX_INHERITANCE_CHAIN = 3;

/** The parts of a workflow the library needs; `WorkflowResponse` satisfies it. */
export type LibraryWorkflow = Pick<
	Workflow,
	'id' | 'name' | 'is_system' | 'issue_count' | 'states' | 'transitions'
>;

/** A state together with the workflow it lives in — how every ref is named. */
export interface LibraryState<W extends LibraryWorkflow = LibraryWorkflow> {
	workflow: W;
	state: WorkflowState;
}

export interface StateLibrary<W extends LibraryWorkflow = LibraryWorkflow> {
	workflows: W[];
	/** By state id, in library order (workflow order, then state order). */
	states: Map<string, LibraryState<W>>;
	/** Base state id → the states pointing at it, library-wide. */
	children: Map<string, LibraryState<W>[]>;
}

export function buildStateLibrary<W extends LibraryWorkflow>(workflows: W[]): StateLibrary<W> {
	// Insertion order is library order, which is what keeps callers that walk
	// `states` grouped by workflow without a second sort.
	const states = new Map<string, LibraryState<W>>();
	for (const workflow of workflows) {
		for (const state of workflow.states) states.set(state.id, { workflow, state });
	}
	const children = new Map<string, LibraryState<W>[]>();
	for (const entry of states.values()) {
		const base = entry.state.inherits_from;
		if (base === null || base === undefined) continue;
		const siblings = children.get(base);
		if (siblings) siblings.push(entry);
		else children.set(base, [entry]);
	}
	return { workflows, states, children };
}

/** `<workflow> / <state>` — state names are unique only within a workflow. */
export const qualifyEntry = (entry: LibraryState): string =>
	`${entry.workflow.name} / ${entry.state.name}`;

/** The same, from an id: falls back to the bare id for a state we cannot see. */
export function qualifyState(lib: StateLibrary, id: string): string {
	const entry = lib.states.get(id);
	return entry ? qualifyEntry(entry) : id;
}

/** The states pointing at `id`, in library order; `[]` when none. */
export function childrenOf<W extends LibraryWorkflow>(
	lib: StateLibrary<W>,
	id: string
): LibraryState<W>[] {
	return lib.children.get(id) ?? [];
}

/**
 * The ids above `id`, parent first and root last. Stops at a repeat, so a
 * cycle stored by a hand-edited database terminates instead of looping.
 */
export function ancestorsOf(lib: StateLibrary, id: string): string[] {
	const chain: string[] = [];
	const seen = new Set<string>([id]);
	let cursor = lib.states.get(id)?.state.inherits_from ?? null;
	while (cursor !== null && !seen.has(cursor)) {
		chain.push(cursor);
		seen.add(cursor);
		cursor = lib.states.get(cursor)?.state.inherits_from ?? null;
	}
	return chain;
}

/**
 * A base-like workflow by the convention in `specs/context/SPEC.md`: no
 * transitions and every state in the backlog category, i.e. a library of
 * stages nothing is ever bound to rather than a workflow issues move through.
 */
export function isBaseLike(workflow: LibraryWorkflow): boolean {
	return (
		workflow.transitions.length === 0 &&
		workflow.states.length > 0 &&
		workflow.states.every((s) => s.category === 'backlog')
	);
}

/** The length of the chain a state would sit in if it pointed at `baseId`. */
export function chainLengthVia(lib: StateLibrary, baseId: string): number {
	return ancestorsOf(lib, baseId).length + 2;
}

/** True when pointing `stateId` at `baseId` would close a loop (self included). */
export function wouldCycle(lib: StateLibrary, stateId: string, baseId: string): boolean {
	return baseId === stateId || ancestorsOf(lib, baseId).includes(stateId);
}

export interface PickerGroup<W extends LibraryWorkflow = LibraryWorkflow> {
	workflow: W;
	states: WorkflowState[];
	baseLike: boolean;
}

/**
 * The `<optgroup>`s of an "Inherits from" picker: base-like workflows first
 * (alphabetical), then the state's own workflow — intra-workflow pointers are
 * the API's primary path — then the rest alphabetically. Only the state
 * itself is omitted; empty groups are dropped.
 */
export function pickerGroups<W extends LibraryWorkflow>(
	lib: StateLibrary<W>,
	opts: { ownWorkflowId?: string | null; excludeStateId?: string | null } = {}
): PickerGroup<W>[] {
	const own = opts.ownWorkflowId ?? null;
	const exclude = opts.excludeStateId ?? null;
	const byName = (a: W, b: W) => a.name.localeCompare(b.name);
	const bases = lib.workflows.filter((w) => w.id !== own && isBaseLike(w)).sort(byName);
	const ownWorkflow = lib.workflows.filter((w) => w.id === own);
	const rest = lib.workflows.filter((w) => w.id !== own && !isBaseLike(w)).sort(byName);
	return [...bases, ...ownWorkflow, ...rest]
		.map((workflow) => ({
			workflow,
			states: workflow.states.filter((s) => s.id !== exclude),
			baseLike: isBaseLike(workflow)
		}))
		.filter((group) => group.states.length > 0);
}
