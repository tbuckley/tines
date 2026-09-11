import {
	ARTIFACT_NAME_PATTERN,
	ARTIFACT_TYPES,
	STATE_CATEGORIES,
	STATE_PROMPT_NAME,
	type ArtifactRequirement,
	type ArtifactType,
	type CreateWorkflowRequest,
	type ClearedInheritance,
	type DeletedContextItem,
	type StateCategory,
	type UpdateWorkflowRequest,
	type WorkflowResponse,
	type WorkflowStateInput,
	type WorkflowTransitionInput
} from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { newId, type Database, type WorkflowStateTable } from '$lib/server/db';
import type { DispatchEffects } from '$lib/server/dispatch-effects';
import { findAttachedContext, seedPromptQueries, sweepAttachedContext } from './context';
import {
	MAX_INHERITANCE_CHAIN,
	ApiFail,
	notFound,
	optionalString,
	requireString,
	runAtomic,
	type ActorContext
} from './core';
import { insertValues, type QueryGuard } from './query-guard';
import { eventInsert } from './events';
import { assertStatesNotScheduled, assertWorkflowNotScheduled } from './schedules';

interface ResolvedState {
	id: string;
	name: string;
	category: StateCategory;
	position: number;
	isNew: boolean;
	/** Initial stage instructions (new states only): seeds a state-scoped prompt item. */
	prompt?: string;
	/**
	 * The requested base state (Tines/238). `undefined` means "unchanged" and
	 * is only reachable for an existing state; `null` clears. A string that
	 * named a state in the same request is already rewritten to that state's
	 * id here; anything else is a candidate id in another workflow, checked
	 * against the DB by `resolveInheritance`.
	 */
	inheritsFrom: string | null | undefined;
}

export interface ResolvedDef {
	states: ResolvedState[];
	transitions: {
		id: string;
		name: string;
		from_state_id: string;
		to_state_id: string;
		requires?: ArtifactRequirement[];
	}[];
	initialStateId: string;
}

type DiffTransition = {
	name: string;
	from_state_id: string;
	to_state_id: string;
	requires?: ArtifactRequirement[];
};

/**
 * Summarize transition edits using the server's uniqueness rule: an action is
 * identified by source state plus case-insensitive name. Parallel actions to
 * one target therefore remain distinct. An otherwise unambiguous replacement
 * on the same state pair is retained as a rename rather than add + remove.
 */
export function diffTransitions(
	oldTransitions: DiffTransition[],
	newTransitions: DiffTransition[]
) {
	const key = (t: DiffTransition) => `${t.from_state_id}\0${t.name.trim().toLowerCase()}`;
	const pair = (t: DiffTransition) => `${t.from_state_id}\0${t.to_state_id}`;
	const oldByKey = new Map(oldTransitions.map((t) => [key(t), t]));
	const newByKey = new Map(newTransitions.map((t) => [key(t), t]));
	const unmatchedOld = oldTransitions.filter((t) => !newByKey.has(key(t)));
	const unmatchedNew = newTransitions.filter((t) => !oldByKey.has(key(t)));
	const renamed: { from: string; to: string }[] = [];
	const renamedOld = new Set<DiffTransition>();
	const renamedNew = new Set<DiffTransition>();

	for (const old of unmatchedOld) {
		const oldAtPair = unmatchedOld.filter((t) => pair(t) === pair(old));
		const newAtPair = unmatchedNew.filter((t) => pair(t) === pair(old));
		if (oldAtPair.length === 1 && newAtPair.length === 1) {
			renamed.push({ from: old.name, to: newAtPair[0].name });
			renamedOld.add(old);
			renamedNew.add(newAtPair[0]);
		}
	}

	for (const [actionKey, current] of newByKey) {
		const old = oldByKey.get(actionKey);
		if (old && old.name !== current.name) renamed.push({ from: old.name, to: current.name });
	}

	return {
		added: unmatchedNew.filter((t) => !renamedNew.has(t)).length,
		removed: unmatchedOld.filter((t) => !renamedOld.has(t)).length,
		renamed,
		requirementsChanged: [...newByKey.entries()].some(([actionKey, t]) => {
			const old = oldByKey.get(actionKey);
			return old && JSON.stringify(old.requires ?? null) !== JSON.stringify(t.requires ?? null);
		})
	};
}

/**
 * Validates a transition's artifact requirements: slug slot names (unique
 * per transition), known types, content_type only alongside type file/text.
 * Returns undefined for absent/empty input (stored as NULL).
 */
function resolveRequirements(input: unknown, where: string): ArtifactRequirement[] | undefined {
	if (input === undefined || input === null) return undefined;
	if (!Array.isArray(input)) {
		throw new ApiFail(422, 'invalid_field', `${where}.requires must be an array of requirements`, {
			field: `${where}.requires`
		});
	}
	if (input.length === 0) return undefined;
	const seen = new Set<string>();
	return input.map((raw, j) => {
		const field = `${where}.requires[${j}]`;
		const r = (raw ?? {}) as Record<string, unknown>;
		const artifact = requireString(r.artifact, `${field}.artifact`, { max: 100 }).trim();
		if (!ARTIFACT_NAME_PATTERN.test(artifact)) {
			throw new ApiFail(
				422,
				'invalid_field',
				`${field}.artifact must be a slug-like artifact name ([a-z0-9-]+); got "${artifact}"`,
				{ field: `${field}.artifact` }
			);
		}
		if (seen.has(artifact)) {
			throw new ApiFail(
				422,
				'duplicate_requirement',
				`${where} requires artifact "${artifact}" more than once`,
				{ field: `${field}.artifact` }
			);
		}
		seen.add(artifact);
		const requirement: ArtifactRequirement = { artifact };
		if (r.type !== undefined) {
			if (typeof r.type !== 'string' || !(ARTIFACT_TYPES as readonly string[]).includes(r.type)) {
				throw new ApiFail(
					422,
					'unknown_artifact_type',
					`${field}.type must be one of ${ARTIFACT_TYPES.join(', ')}; got ${JSON.stringify(r.type)}`,
					{ field: `${field}.type`, allowed_types: [...ARTIFACT_TYPES] }
				);
			}
			requirement.type = r.type as ArtifactType;
		}
		if (r.content_type !== undefined) {
			const contentType = requireString(r.content_type, `${field}.content_type`, {
				max: 100
			}).trim();
			// A prefix match against declared MIME types is only meaningful for
			// payloads that carry one.
			if (requirement.type !== 'file' && requirement.type !== 'text') {
				throw new ApiFail(
					422,
					'invalid_field',
					`${field}.content_type only applies with type "file" or "text" (content types are declared on file/text payloads)`,
					{ field: `${field}.content_type` }
				);
			}
			requirement.content_type = contentType;
		}
		const description = optionalString(r.description, `${field}.description`, { max: 500 })?.trim();
		if (description) requirement.description = description;
		return requirement;
	});
}

/**
 * Validates state/transition inputs and resolves name-or-id references.
 * Enforces: ≥1 state, unique non-empty names, valid categories, initial
 * state categorized backlog/active, transitions between known states, no
 * self-transitions, no duplicates.
 */
export function resolveDef(
	statesInput: WorkflowStateInput[],
	transitionsInput: WorkflowTransitionInput[],
	initialRef: string,
	existingStates: Pick<WorkflowStateTable, 'id' | 'name' | 'category'>[]
): ResolvedDef {
	if (!Array.isArray(statesInput) || statesInput.length === 0) {
		throw new ApiFail(422, 'no_states', 'A workflow needs at least one state');
	}
	const existingById = new Map(existingStates.map((s) => [s.id, s]));

	const states: ResolvedState[] = [];
	const byName = new Map<string, ResolvedState>();
	const byId = new Map<string, ResolvedState>();
	for (const [i, input] of statesInput.entries()) {
		const name = requireString(input.name, `states[${i}].name`, { max: 100 }).trim();
		if (!STATE_CATEGORIES.includes(input.category)) {
			throw new ApiFail(
				422,
				'invalid_category',
				`State "${name}" has invalid category "${input.category}"`,
				{ allowed_categories: STATE_CATEGORIES }
			);
		}
		if (byName.has(name)) {
			throw new ApiFail(422, 'duplicate_state_name', `State name "${name}" is used more than once`);
		}
		if (input.id !== undefined && !existingById.has(input.id)) {
			throw new ApiFail(
				422,
				'unknown_state',
				`State id "${input.id}" is not part of this workflow`
			);
		}
		// `prompt` seeds a state-scoped "instructions" item — new states only;
		// existing stage instructions are edited through the context surfaces.
		const prompt =
			optionalString(input.prompt, `states[${i}].prompt`, { max: 100_000 })?.trim() || undefined;
		if (prompt !== undefined && input.id !== undefined) {
			throw new ApiFail(
				422,
				'prompt_on_existing_state',
				`State "${name}" already exists; its instructions are edited as context items, not re-sent through workflow updates`,
				{ state_id: input.id }
			);
		}
		// Inheritance pointer: merge-patch on an existing state (absent =
		// unchanged), plain "no base" on a new one. Resolution of the value
		// against this request's own states happens below, once every name is
		// known; anything unresolved is left for `resolveInheritance`.
		let inheritsFrom: string | null | undefined;
		if (input.inherits_from === undefined) {
			inheritsFrom = input.id === undefined ? null : undefined;
		} else if (input.inherits_from === null) {
			inheritsFrom = null;
		} else {
			inheritsFrom = requireString(input.inherits_from, `states[${i}].inherits_from`, {
				max: 100
			}).trim();
			if (!inheritsFrom) {
				throw new ApiFail(
					422,
					'invalid_field',
					`State "${name}" has an empty inherits_from; use null to clear it`,
					{ field: `states[${i}].inherits_from` }
				);
			}
		}
		const state: ResolvedState = {
			id: input.id ?? newId('wfs'),
			name,
			category: input.category,
			position: i,
			isNew: input.id === undefined,
			prompt,
			inheritsFrom
		};
		if (byId.has(state.id)) {
			throw new ApiFail(422, 'duplicate_state', `State id "${state.id}" is listed more than once`);
		}
		states.push(state);
		byName.set(name, state);
		byId.set(state.id, state);
	}

	// Now that every name is known, point each `inherits_from` at a state in
	// this request when it names one. An unresolved string stays as-is: it is
	// a candidate state id in another workflow, which only the DB can judge.
	for (const [i, state] of states.entries()) {
		if (typeof state.inheritsFrom !== 'string') continue;
		const local = byId.get(state.inheritsFrom) ?? byName.get(state.inheritsFrom);
		if (local === state || state.inheritsFrom === state.id) {
			throw new ApiFail(
				422,
				'self_inheritance',
				`State "${state.name}" cannot inherit from itself`,
				{ field: `states[${i}].inherits_from` }
			);
		}
		if (local) state.inheritsFrom = local.id;
	}

	const resolveRef = (ref: string, what: string): ResolvedState => {
		const found = byId.get(ref) ?? byName.get(ref);
		if (!found) {
			throw new ApiFail(422, 'unknown_state', `${what} references unknown state "${ref}"`, {
				known_states: states.map((s) => ({ id: s.id, name: s.name }))
			});
		}
		return found;
	};

	const initial = resolveRef(initialRef, 'Initial state');
	if (initial.category !== 'backlog' && initial.category !== 'active') {
		throw new ApiFail(
			422,
			'invalid_initial_state',
			`The initial state must be categorized "backlog" or "active" (got "${initial.category}" on "${initial.name}")`
		);
	}

	const transitions: ResolvedDef['transitions'] = [];
	const seenActions = new Set<string>();
	for (const [i, t] of (transitionsInput ?? []).entries()) {
		const name = requireString(t.name, `transitions[${i}].name`, { max: 100 }).trim();
		const from = resolveRef(requireString(t.from, `transitions[${i}].from`), `transitions[${i}]`);
		const to = resolveRef(requireString(t.to, `transitions[${i}].to`), `transitions[${i}]`);
		if (from.id === to.id) {
			throw new ApiFail(
				422,
				'self_transition',
				`Transition "${name}" loops "${from.name}" onto itself; self-transitions are not allowed`
			);
		}
		// Action names must be unambiguous within a source state ("reject"
		// out of two different states is fine).
		const actionKey = `${from.id}:${name.toLowerCase()}`;
		if (seenActions.has(actionKey)) {
			throw new ApiFail(
				422,
				'duplicate_action',
				`State "${from.name}" has more than one transition named "${name}"`
			);
		}
		seenActions.add(actionKey);
		const requires = resolveRequirements(t.requires, `transitions[${i}]`);
		transitions.push({
			id: newId('wft'),
			name,
			from_state_id: from.id,
			to_state_id: to.id,
			...(requires ? { requires } : {})
		});
	}

	return { states, transitions, initialStateId: initial.id };
}

// ---------------------------------------------------------------------------
// Inheritance (Tines/238)

/** A state as the inheritance machinery needs to name it in a message. */
interface StateRef {
	id: string;
	name: string;
	workflowId: string;
	workflowName: string;
}

/** One pointer that this request moves — the `inheritance_changed` payload entry. */
export interface InheritanceChange {
	/** The child's workflow name (external children on a forced clear are elsewhere). */
	workflow: string;
	/** The child state's name. */
	state: string;
	/** `<workflow> / <state>` of the old and new base, or null. */
	from: string | null;
	to: string | null;
}

export interface ResolvedInheritance {
	/** Final pointer per state in the request, including the unchanged ones. */
	pointers: Map<string, string | null>;
	/** Ids of the states whose stored pointer this request moves — the UPDATE pass. */
	changedIds: Set<string>;
	/** Only the states whose stored pointer this request moves. */
	changes: InheritanceChange[];
	/** Denormalized refs for every state named above. */
	refs: Map<string, StateRef>;
}

const stateRefLabel = (ref: StateRef | undefined, id: string): string =>
	ref ? `${ref.workflowName} / ${ref.name}` : id;

/** Loads states by id, restricted to workflows the user can see (own or system). */
async function loadVisibleStates(
	db: Kysely<Database>,
	userId: string,
	ids: string[]
): Promise<Map<string, StateRef & { inheritsFrom: string | null }>> {
	if (ids.length === 0) return new Map();
	const rows = await db
		.selectFrom('workflow_state')
		.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
		.select([
			'workflow_state.id as id',
			'workflow_state.name as name',
			'workflow_state.inherits_from_state_id as inherits_from_state_id',
			'workflow.id as workflow_id',
			'workflow.name as workflow_name'
		])
		// Same visibility predicate as `resolveScope`: your workflows, or the
		// shared standard workflow (which can be a base, never a child).
		.where((eb) => eb.or([eb('workflow.user_id', '=', userId), eb('workflow.user_id', 'is', null)]))
		.where('workflow_state.id', 'in', ids)
		.execute();
	return new Map(
		rows.map((r) => [
			r.id,
			{
				id: r.id,
				name: r.name,
				workflowId: r.workflow_id,
				workflowName: r.workflow_name,
				inheritsFrom: r.inherits_from_state_id
			}
		])
	);
}

/**
 * The DB half of inheritance validation, beside the pure `resolveDef`: every
 * referenced base exists and is visible, and no chain this request would
 * store cycles or exceeds `MAX_INHERITANCE_CHAIN` — walking upwards from the
 * request's own states *and* downwards through states that already inherit
 * from them, since a new parent lengthens their chains too.
 *
 * Returns the final pointer for every state in the request (`undefined` in
 * `ResolvedState.inheritsFrom` means "keep what is stored") plus the subset
 * that actually moves, which is both the UPDATE pass and the event payload.
 */
export async function resolveInheritance(
	db: Kysely<Database>,
	userId: string,
	workflow: { id: string | null; name: string },
	states: ResolvedState[],
	current: { id: string; name: string; inherits_from: string | null }[]
): Promise<ResolvedInheritance> {
	const currentById = new Map(current.map((s) => [s.id, s]));
	const requestIds = new Set(states.map((s) => s.id));
	const pointers = new Map<string, string | null>();
	for (const s of states) {
		pointers.set(
			s.id,
			s.inheritsFrom === undefined ? (currentById.get(s.id)?.inherits_from ?? null) : s.inheritsFrom
		);
	}

	const refs = new Map<string, StateRef>();
	for (const s of states) {
		refs.set(s.id, {
			id: s.id,
			name: s.name,
			workflowId: workflow.id ?? '',
			workflowName: workflow.name
		});
	}

	// Everything the walks need to know about states outside this request.
	const external = new Map<string, StateRef & { inheritsFrom: string | null }>();
	const loadExternal = async (ids: string[]) => {
		const missing = ids.filter((id) => !requestIds.has(id) && !external.has(id));
		if (missing.length === 0) return;
		const loaded = await loadVisibleStates(db, userId, [...new Set(missing)]);
		for (const [id, row] of loaded) {
			external.set(id, row);
			refs.set(id, row);
		}
	};

	// 1. Every base a state points at must exist and be visible.
	const targets = [...pointers.values()].filter((v): v is string => v !== null);
	await loadExternal(targets);
	for (const s of states) {
		const target = pointers.get(s.id);
		if (target === null || target === undefined) continue;
		// A base this same request drops is still stored at validation time,
		// so it would pass the existence check below and then fail the batch
		// on the FK as an unhandled error. Refuse it here instead, so every
		// way of getting inheritance wrong answers with a readable 422. Only a
		// pointer this request *moves* is caught: keeping a stored pointer onto
		// a state being removed is the `state_inherited` guard's case, which
		// answers with its own 422 and clears under `force_clear_inheritance`.
		if (
			!requestIds.has(target) &&
			currentById.has(target) &&
			target !== (currentById.get(s.id)?.inherits_from ?? null)
		) {
			throw new ApiFail(
				422,
				'inheritance_target_removed',
				`State "${s.name}" inherits from state "${currentById.get(target)!.name}", which this request removes: keep that state, or point elsewhere`,
				{ field: 'inherits_from', state_id: s.id }
			);
		}
		if (!requestIds.has(target) && !external.has(target)) {
			throw new ApiFail(
				422,
				'unknown_state',
				`State "${s.name}" inherits from unknown state "${target}"`,
				{ field: 'inherits_from', state_id: s.id }
			);
		}
	}

	const nextOf = (id: string): string | null =>
		requestIds.has(id) ? (pointers.get(id) ?? null) : (external.get(id)?.inheritsFrom ?? null);

	/** Walks up from `startId`, returning the chain (leaf → root, `startId` first). */
	const walkUp = async (startId: string, startName: string): Promise<string[]> => {
		const chain = [startId];
		const seen = new Set([startId]);
		let cursor = nextOf(startId);
		while (cursor !== null) {
			if (seen.has(cursor)) {
				const loop = [...chain, cursor].map((id) => stateRefLabel(refs.get(id), id));
				throw new ApiFail(422, 'inheritance_cycle', `Inheritance would loop: ${loop.join(' → ')}`, {
					chain: [...chain, cursor]
				});
			}
			chain.push(cursor);
			seen.add(cursor);
			if (chain.length > MAX_INHERITANCE_CHAIN) {
				const labels = chain.map((id) => stateRefLabel(refs.get(id), id));
				throw new ApiFail(
					422,
					'inheritance_too_deep',
					`Inheritance chain for state "${startName}" is ${chain.length} states long (${labels.join(' → ')}); the limit is ${MAX_INHERITANCE_CHAIN}`,
					{ chain }
				);
			}
			await loadExternal([cursor]);
			cursor = nextOf(cursor);
		}
		return chain;
	};

	// 2. Ancestors: cycles and depth, for every state in the request.
	const chainLength = new Map<string, number>();
	for (const s of states) {
		chainLength.set(s.id, (await walkUp(s.id, s.name)).length);
	}

	// 3. Descendants: states elsewhere that already inherit from one of ours.
	// Giving a state a parent lengthens their chains, so the cap has to be
	// checked from below too or "no stored chain exceeds the cap" would only
	// hold for the states this request happens to mention.
	let frontier = states.filter((s) => (pointers.get(s.id) ?? null) !== null).map((s) => s.id);
	let distance = 1;
	while (frontier.length > 0 && distance < MAX_INHERITANCE_CHAIN) {
		const children = await db
			.selectFrom('workflow_state')
			.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
			.select([
				'workflow_state.id as id',
				'workflow_state.name as name',
				'workflow.id as workflow_id',
				'workflow.name as workflow_name',
				'workflow_state.inherits_from_state_id as parent_id'
			])
			.where('workflow_state.inherits_from_state_id', 'in', frontier)
			.where((eb) =>
				eb.or([eb('workflow.user_id', '=', userId), eb('workflow.user_id', 'is', null)])
			)
			.execute();
		const next: string[] = [];
		for (const child of children) {
			// A child listed in this request has its own pointer in `pointers`
			// and was already walked from the top.
			if (requestIds.has(child.id)) continue;
			refs.set(child.id, {
				id: child.id,
				name: child.name,
				workflowId: child.workflow_id,
				workflowName: child.workflow_name
			});
			const rootChain = chainLength.get(child.parent_id!) ?? 1;
			if (rootChain + distance > MAX_INHERITANCE_CHAIN) {
				throw new ApiFail(
					422,
					'inheritance_too_deep',
					`Inheritance chain through "${stateRefLabel(refs.get(child.id), child.id)}" would be ${rootChain + distance} states long; the limit is ${MAX_INHERITANCE_CHAIN}`,
					{ state_id: child.id }
				);
			}
			chainLength.set(child.id, rootChain + distance);
			next.push(child.id);
		}
		frontier = next;
		distance += 1;
	}

	// 4. What actually moves.
	const changes: InheritanceChange[] = [];
	const changedIds = new Set<string>();
	for (const s of states) {
		const to = pointers.get(s.id) ?? null;
		const from = currentById.get(s.id)?.inherits_from ?? null;
		if (to === from) continue;
		if (from) await loadExternal([from]);
		changedIds.add(s.id);
		changes.push({
			workflow: workflow.name,
			state: s.name,
			from: from ? stateRefLabel(refs.get(from), from) : null,
			to: to ? stateRefLabel(refs.get(to), to) : null
		});
	}
	return { pointers, changedIds, changes, refs };
}

/**
 * States that inherit from any of `baseIds` and are not themselves going
 * away — the children a removal has to re-point or refuse. `excludeIds`
 * carries the states the same operation deletes.
 */
async function inheritingChildren(
	db: Kysely<Database>,
	userId: string,
	baseIds: string[],
	excludeIds: Set<string>
): Promise<(StateRef & { baseId: string })[]> {
	if (baseIds.length === 0) return [];
	const rows = await db
		.selectFrom('workflow_state')
		.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
		.select([
			'workflow_state.id as id',
			'workflow_state.name as name',
			'workflow_state.inherits_from_state_id as base_id',
			'workflow.id as workflow_id',
			'workflow.name as workflow_name'
		])
		.where('workflow_state.inherits_from_state_id', 'in', baseIds)
		.where((eb) => eb.or([eb('workflow.user_id', '=', userId), eb('workflow.user_id', 'is', null)]))
		.execute();
	return rows
		.filter((r) => !excludeIds.has(r.id))
		.map((r) => ({
			id: r.id,
			name: r.name,
			workflowId: r.workflow_id,
			workflowName: r.workflow_name,
			baseId: r.base_id!
		}));
}

/** `cleared_inheritance` entries for children a forced operation re-pointed to null. */
function clearedInheritanceFor(
	children: (StateRef & { baseId: string })[],
	baseLabel: (id: string) => string
): ClearedInheritance[] {
	return children.map((c) => ({
		state_id: c.id,
		state_name: c.name,
		workflow_id: c.workflowId,
		workflow_name: c.workflowName,
		was: baseLabel(c.baseId)
	}));
}

/** Non-fatal advisories: a non-done state with no way out is probably a bug. */
export function deadEndWarnings(def: {
	states: Pick<ResolvedState, 'id' | 'name' | 'category'>[];
	transitions: { from_state_id: string }[];
}): string[] {
	const hasOutgoing = new Set(def.transitions.map((t) => t.from_state_id));
	return def.states
		.filter((s) => s.category !== 'done' && !hasOutgoing.has(s.id))
		.map(
			(s) =>
				`State "${s.name}" is not categorized "done" but has no outgoing transitions — issues that reach it will be stuck.`
		);
}

// ---------------------------------------------------------------------------
// Loading

export async function loadWorkflows(
	db: Kysely<Database>,
	userId: string,
	id?: string
): Promise<WorkflowResponse[]> {
	let q = db
		.selectFrom('workflow')
		.selectAll('workflow')
		.select((eb) =>
			eb
				.selectFrom('issue')
				// Scope through project ownership: for the shared system
				// workflow this must count only the requesting user's issues.
				.innerJoin('project', 'project.id', 'issue.project_id')
				.whereRef('issue.workflow_id', '=', 'workflow.id')
				.where('project.user_id', '=', userId)
				.select((eb2) => eb2.fn.countAll<number>().as('n'))
				.as('issue_count')
		)
		.where((eb) => eb.or([eb('workflow.user_id', '=', userId), eb('workflow.user_id', 'is', null)]))
		.orderBy('workflow.user_id asc') // system workflow (NULL) first
		.orderBy('workflow.created_at asc');
	if (id !== undefined) q = q.where('workflow.id', '=', id);
	const rows = await q.execute();
	if (rows.length === 0) return [];

	const ids = rows.map((r) => r.id);
	const [states, transitions] = await Promise.all([
		db
			.selectFrom('workflow_state')
			.selectAll()
			.where('workflow_id', 'in', ids)
			.orderBy('position asc')
			.execute(),
		db.selectFrom('workflow_transition').selectAll().where('workflow_id', 'in', ids).execute()
	]);

	return rows.map((row) => {
		const wfStates = states.filter((s) => s.workflow_id === row.id);
		const wfTransitions = transitions.filter((t) => t.workflow_id === row.id);
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			is_system: row.user_id === null,
			initial_state_id: row.initial_state_id,
			states: wfStates.map((s) => ({
				id: s.id,
				name: s.name,
				category: s.category,
				position: s.position,
				inherits_from: s.inherits_from_state_id
			})),
			transitions: wfTransitions.map((t) => ({
				id: t.id,
				name: t.name,
				from_state_id: t.from_state_id,
				to_state_id: t.to_state_id,
				...(t.requirements ? { requires: JSON.parse(t.requirements) as ArtifactRequirement[] } : {})
			})),
			issue_count: Number(row.issue_count ?? 0),
			created_at: row.created_at,
			updated_at: row.updated_at,
			warnings: deadEndWarnings({
				states: wfStates,
				transitions: wfTransitions
			})
		};
	});
}

export async function loadWorkflow(
	db: Kysely<Database>,
	userId: string,
	id: string
): Promise<WorkflowResponse> {
	const [wf] = await loadWorkflows(db, userId, id);
	if (!wf) throw notFound();
	return wf;
}

// ---------------------------------------------------------------------------
// Structural identity (shared by library import and starters)

/**
 * Sorted by each entry's own canonical serialization, so the order entries
 * arrive in never reaches the fingerprint. A fresh array: the caller's
 * request is about to be acted on, and must not be reordered under it.
 */
function sortedByEncoding<T>(entries: T[], encode: (entry: T) => unknown[]): unknown[][] {
	return entries
		.map((entry) => {
			const tuple = encode(entry);
			return { tuple, key: JSON.stringify(tuple) };
		})
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.map((e) => e.tuple);
}

/**
 * Canonical form of a workflow definition, for "same or different?". Covers
 * the initial state, each state's name and category, and the transition set
 * with its artifact requirements — deliberately *not* stage instructions,
 * description or inheritance, which are edited independently of the shape.
 *
 * Every value is a fixed position in a JSON tuple rather than a delimited
 * string, so no user text can spell a separator: a state named
 * `Review:active|Done` once serialized exactly as the two states it names,
 * and a requirement description could hide a whole second gate (Tines/413).
 * State order is significant; transitions and requirements are not.
 */
export function workflowFingerprint(wf: CreateWorkflowRequest): string {
	return JSON.stringify([
		wf.initial_state,
		wf.states.map((s) => [s.name, s.category]),
		sortedByEncoding(wf.transitions, (t) => [
			t.from,
			t.name,
			t.to,
			sortedByEncoding(t.requires ?? [], (r) => [
				r.artifact,
				r.type ?? '',
				r.content_type ?? '',
				r.description ?? ''
			])
		])
	]);
}

/**
 * A stored workflow expressed as the request that would create it — the other
 * side of a fingerprint comparison.
 */
export function workflowAsRequest(wf: WorkflowResponse): CreateWorkflowRequest {
	return {
		name: wf.name,
		initial_state: wf.states.find((s) => s.id === wf.initial_state_id)?.name ?? '',
		states: [...wf.states]
			.sort((a, b) => a.position - b.position)
			.map((s) => ({ name: s.name, category: s.category })),
		transitions: wf.transitions.map((t) => ({
			name: t.name,
			from: wf.states.find((s) => s.id === t.from_state_id)?.name ?? '',
			to: wf.states.find((s) => s.id === t.to_state_id)?.name ?? '',
			...(t.requires ? { requires: t.requires } : {})
		}))
	};
}

// ---------------------------------------------------------------------------
// Mutations

/**
 * Every statement a brand-new workflow needs — the workflow row, its states
 * and transitions, the stage-instruction seeds, the inheritance UPDATE pass
 * and the `workflow.created` event — as one list, so a caller that is already
 * building a batch (project creation from a starter, Tines/248) can splice
 * them in rather than run a batch of its own.
 */
export function workflowInsertQueries(
	db: Kysely<Database>,
	actor: ActorContext,
	opts: {
		guard?: QueryGuard;
		phase?: 'all' | 'shells' | 'inheritance';
		eventId?: string;
		/** Stable IDs for inline instruction seeds, keyed by preallocated state ID. */
		promptIds?: Record<string, { id: string; eventId: string }>;
		id: string;
		name: string;
		description: string;
		def: ResolvedDef;
		inh: ResolvedInheritance;
		now: number;
		/** Merged into the `workflow.created` payload (e.g. `{ starter: 'code' }`). */
		eventPayload?: Record<string, unknown>;
	}
): CompiledQuery[] {
	const { id, name, description, def, inh, now } = opts;
	const shells: CompiledQuery[] = [
		insertValues(
			db,
			'workflow',
			{
				id,
				user_id: actor.userId,
				name,
				description,
				initial_state_id: def.initialStateId,
				created_at: now,
				updated_at: now
			},
			opts.guard
		),
		...def.states.map((s) =>
			insertValues(
				db,
				'workflow_state',
				{
					id: s.id,
					workflow_id: id,
					name: s.name,
					category: s.category,
					position: s.position,
					created_at: now
				},
				opts.guard
			)
		),
		...def.transitions.map((t) =>
			insertValues(
				db,
				'workflow_transition',
				{
					id: t.id,
					workflow_id: id,
					name: t.name,
					from_state_id: t.from_state_id,
					to_state_id: t.to_state_id,
					requirements: t.requires ? JSON.stringify(t.requires) : null
				},
				opts.guard
			)
		),
		// Initial stage instructions ride along in the same transaction.
		...def.states
			.filter((s) => s.prompt !== undefined)
			.flatMap(
				(s) =>
					seedPromptQueries(db, actor, {
						...opts.promptIds?.[s.id],
						guard: opts.guard,
						name: STATE_PROMPT_NAME,
						body: s.prompt!,
						workflowStateId: s.id,
						label: `state ${s.name}`,
						now
					}).queries
			),

		eventInsert(
			db,
			actor,
			{
				id: opts.eventId,
				createdAt: now,
				type: 'workflow.created',
				payload: {
					workflow_id: id,
					name,
					...(inh.changes.length ? { inheritance_changed: inh.changes } : {}),
					...opts.eventPayload
				}
			},
			opts.guard
		)
	];
	const inheritance: CompiledQuery[] = [
		// Pointers go in a second pass: a self-FK cannot be satisfied by an
		// insert whose target is later in the same batch, and intra-workflow
		// inheritance is exactly that case.
		...def.states
			.filter((s) => (inh.pointers.get(s.id) ?? null) !== null)
			.map((s) =>
				db
					.updateTable('workflow_state')
					.set({ inherits_from_state_id: inh.pointers.get(s.id)! })
					.where('id', '=', s.id)
					.where(opts.guard?.predicate ?? sql<boolean>`1`)
					.compile()
			)
	];
	return opts.phase === 'shells'
		? shells
		: opts.phase === 'inheritance'
			? inheritance
			: [...shells.slice(0, -1), ...inheritance, shells[shells.length - 1]];
}

/** Pure create fields and definition validation, shared with library planning. */
export function validateWorkflowCreateFields(body: CreateWorkflowRequest) {
	const name = requireString(body.name, 'name', { max: 200 }).trim();
	const description = optionalString(body.description, 'description', { max: 10000 }) ?? '';
	const def = resolveDef(body.states, body.transitions ?? [], body.initial_state, []);
	return { name, description, def };
}

export async function createWorkflow(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	body: CreateWorkflowRequest
): Promise<WorkflowResponse> {
	const { name, description, def } = validateWorkflowCreateFields(body);
	const id = newId('wf');
	const inh = await resolveInheritance(db, actor.userId, { id, name }, def.states, []);
	const now = Date.now();
	await runAtomic(env, workflowInsertQueries(db, actor, { id, name, description, def, inh, now }));
	return loadWorkflow(db, actor.userId, id);
}

export async function updateWorkflow(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	body: UpdateWorkflowRequest,
	effects?: DispatchEffects
): Promise<WorkflowResponse> {
	const current = await loadWorkflow(db, actor.userId, id);
	if (current.is_system) {
		throw new ApiFail(
			403,
			'workflow_read_only',
			'The standard workflow is read-only; copy it into your library to make changes'
		);
	}

	const name =
		body.name !== undefined ? requireString(body.name, 'name', { max: 200 }).trim() : current.name;
	const description =
		body.description !== undefined
			? (optionalString(body.description, 'description', { max: 10_000 }) ?? '')
			: current.description;

	// No `inherits_from` here on purpose: absent means "unchanged" on an
	// existing state, so a PATCH that only renames the workflow — like every
	// caller that round-trips states without knowing about the field —
	// cannot clear anyone's pointer.
	const statesInput: WorkflowStateInput[] =
		body.states ?? current.states.map((s) => ({ id: s.id, name: s.name, category: s.category }));
	const transitionsInput: WorkflowTransitionInput[] =
		body.transitions ??
		current.transitions.map((t) => ({
			name: t.name,
			from: t.from_state_id,
			to: t.to_state_id,
			requires: t.requires
		}));
	const initialRef = body.initial_state ?? current.initial_state_id;

	let def: ResolvedDef;
	try {
		def = resolveDef(statesInput, transitionsInput, initialRef, current.states);
	} catch (e) {
		// A vanished initial state surfaces as unknown_state; give the
		// spec-mandated guidance for that specific case.
		if (
			e instanceof ApiFail &&
			e.code === 'unknown_state' &&
			body.initial_state === undefined &&
			body.states !== undefined &&
			!body.states.some((s) => s.id === current.initial_state_id)
		) {
			throw new ApiFail(
				422,
				'initial_state_removed',
				'The initial state cannot be deleted; designate another state as initial first (or in the same update)'
			);
		}
		throw e;
	}

	// Editing rule: a state cannot be deleted while any issue sits in it.
	// This read-then-write check is racy on its own, but the FK from
	// issue.state_id is the backstop: an issue moving into a removed state
	// between this check and the batch makes the whole batch fail.
	const keptIds = new Set(def.states.map((s) => s.id));
	const removedStates = current.states.filter((s) => !keptIds.has(s.id));
	if (removedStates.length > 0) {
		const occupied = await db
			.selectFrom('issue')
			.select(['state_id', (eb) => eb.fn.countAll<number>().as('n')])
			.where(
				'state_id',
				'in',
				removedStates.map((s) => s.id)
			)
			.groupBy('state_id')
			.execute();
		if (occupied.length > 0) {
			const details = occupied.map((o) => ({
				state_id: o.state_id,
				state_name: current.states.find((s) => s.id === o.state_id)?.name,
				issue_count: Number(o.n)
			}));
			throw new ApiFail(
				422,
				'state_in_use',
				`Cannot delete ${details.map((d) => `state "${d.state_name}" (${d.issue_count} issue${d.issue_count === 1 ? '' : 's'})`).join(', ')}: move those issues to another state first`,
				{ states: details }
			);
		}
	}

	// Same rule for schedules: a state a scheduled task starts instances in
	// cannot be deleted (the FK's SET NULL is only the race backstop).
	await assertStatesNotScheduled(
		db,
		removedStates.map((s) => s.id)
	);

	// Removing a state with attached context is rejected unless forced; a
	// forced removal sweeps the items (all-or-nothing, even when one PATCH
	// removes multiple states) with a context.deleted event per item.
	const attachedContext = await findAttachedContext(db, actor.userId, {
		stateIds: removedStates.map((s) => s.id)
	});
	const contextSweep = sweepAttachedContext(
		db,
		actor,
		attachedContext,
		body.force_delete_context === true,
		`remove state${removedStates.length === 1 ? ` "${removedStates[0].name}"` : 's'} from workflow "${current.name}"`
	);

	const inh = await resolveInheritance(db, actor.userId, { id, name }, def.states, current.states);

	// Removing a state other states inherit from rewrites those states'
	// prompts, so it is refused unless explicitly forced — the same
	// reject-then-force posture as attached context, with its own flag
	// (sweeping your own items is not consent to change another workflow).
	const removedIds = new Set(removedStates.map((s) => s.id));
	const blockedChildren = (
		await inheritingChildren(db, actor.userId, [...removedIds], removedIds)
	).filter((c) => !(keptIds.has(c.id) && (inh.pointers.get(c.id) ?? null) !== c.baseId));
	const forceClearInheritance = body.force_clear_inheritance === true;
	if (blockedChildren.length > 0 && !forceClearInheritance) {
		const byBase = removedStates
			.filter((s) => blockedChildren.some((c) => c.baseId === s.id))
			.map((s) => ({
				state_id: s.id,
				state_name: s.name,
				children: blockedChildren
					.filter((c) => c.baseId === s.id)
					.map((c) => ({
						state_id: c.id,
						state_name: c.name,
						workflow_id: c.workflowId,
						workflow_name: c.workflowName
					}))
			}));
		throw new ApiFail(
			422,
			'state_inherited',
			`Cannot remove ${byBase
				.map(
					(b) =>
						`state "${b.state_name}" (${b.children.length} state${b.children.length === 1 ? ' inherits' : 's inherit'} context from it: ${b.children.map((c) => `${c.workflow_name} / ${c.state_name}`).join(', ')})`
				)
				.join('; ')}: re-point them first, or pass force_clear_inheritance to clear their pointers`,
			{ states: byBase }
		);
	}
	const clearedInheritance = forceClearInheritance
		? clearedInheritanceFor(blockedChildren, (baseId) => {
				const base = current.states.find((s) => s.id === baseId);
				return base ? `${current.name} / ${base.name}` : baseId;
			})
		: [];

	// Summary diff for the workflow.updated event payload.
	const currentById = new Map(current.states.map((s) => [s.id, s]));
	const statesAdded = def.states.filter((s) => s.isNew).map((s) => s.name);
	const statesRemoved = removedStates.map((s) => s.name);
	const statesRenamed = def.states
		.filter((s) => !s.isNew && currentById.get(s.id) && currentById.get(s.id)!.name !== s.name)
		.map((s) => ({ from: currentById.get(s.id)!.name, to: s.name }));
	const categoriesChanged = def.states
		.filter(
			(s) => !s.isNew && currentById.get(s.id) && currentById.get(s.id)!.category !== s.category
		)
		.map((s) => ({ state: s.name, from: currentById.get(s.id)!.category, to: s.category }));
	const transitionDiff = diffTransitions(current.transitions, def.transitions);

	const payload: Record<string, unknown> = { workflow_id: id, name };
	if (name !== current.name) payload.renamed = { from: current.name, to: name };
	if (description !== current.description) payload.description_changed = true;
	if (statesAdded.length) payload.states_added = statesAdded;
	if (statesRemoved.length) payload.states_removed = statesRemoved;
	if (statesRenamed.length) payload.states_renamed = statesRenamed;
	if (categoriesChanged.length) payload.categories_changed = categoriesChanged;
	if (transitionDiff.added) payload.transitions_added = transitionDiff.added;
	if (transitionDiff.removed) payload.transitions_removed = transitionDiff.removed;
	if (transitionDiff.renamed.length) payload.transitions_renamed = transitionDiff.renamed;
	if (transitionDiff.requirementsChanged) payload.transition_requirements_changed = true;
	const inheritanceChanged = [
		...inh.changes,
		...clearedInheritance.map((c) => ({
			workflow: c.workflow_name,
			state: c.state_name,
			from: c.was,
			to: null
		}))
	];
	if (inheritanceChanged.length) payload.inheritance_changed = inheritanceChanged;
	if (def.initialStateId !== current.initial_state_id) {
		payload.initial_changed = {
			from: currentById.get(current.initial_state_id)?.name,
			to: def.states.find((s) => s.id === def.initialStateId)?.name
		};
	}

	const now = Date.now();
	const queries: CompiledQuery[] = [];
	// Swept context goes first: those items hold foreign keys onto states
	// about to be deleted.
	queries.push(...contextSweep.queries);
	// Old transitions next: they hold foreign keys onto states about to be
	// deleted. Transition ids are not referenced elsewhere, so the set is
	// replaced wholesale.
	queries.push(db.deleteFrom('workflow_transition').where('workflow_id', '=', id).compile());
	// Every pointer onto a state about to vanish is nulled first: the FK has
	// no ON DELETE action on purpose, so a dangling pointer would fail the
	// batch rather than silently rewrite another workflow's prompts. This one
	// statement covers both intra-workflow pointers and the forced clears.
	if (removedStates.length > 0) {
		queries.push(
			db
				.updateTable('workflow_state')
				.set({ inherits_from_state_id: null })
				.where('inherits_from_state_id', 'in', [...removedIds])
				.compile()
		);
	}
	for (const s of removedStates) {
		queries.push(db.deleteFrom('workflow_state').where('id', '=', s.id).compile());
	}
	for (const s of def.states) {
		if (s.isNew) {
			queries.push(
				db
					.insertInto('workflow_state')
					.values({
						id: s.id,
						workflow_id: id,
						name: s.name,
						category: s.category,
						position: s.position,
						created_at: now
					})
					.compile()
			);
		} else {
			queries.push(
				db
					.updateTable('workflow_state')
					.set({ name: s.name, category: s.category, position: s.position })
					.where('id', '=', s.id)
					.compile()
			);
		}
	}
	for (const t of def.transitions) {
		queries.push(
			db
				.insertInto('workflow_transition')
				.values({
					id: t.id,
					workflow_id: id,
					name: t.name,
					from_state_id: t.from_state_id,
					to_state_id: t.to_state_id,
					requirements: t.requires ? JSON.stringify(t.requires) : null
				})
				.compile()
		);
	}
	// Initial stage instructions for newly added states.
	for (const s of def.states) {
		if (s.isNew && s.prompt !== undefined) {
			queries.push(
				...seedPromptQueries(db, actor, {
					name: STATE_PROMPT_NAME,
					body: s.prompt,
					workflowStateId: s.id,
					label: `state ${s.name}`,
					now
				}).queries
			);
		}
	}
	// Pointer pass, after every insert so a new state can be a new state's base.
	for (const stateId of inh.changedIds) {
		queries.push(
			db
				.updateTable('workflow_state')
				.set({ inherits_from_state_id: inh.pointers.get(stateId) ?? null })
				.where('id', '=', stateId)
				.compile()
		);
	}
	queries.push(
		db
			.updateTable('workflow')
			.set({ name, description, initial_state_id: def.initialStateId, updated_at: now })
			.where('id', '=', id)
			.compile(),
		eventInsert(db, actor, { type: 'workflow.updated', payload })
	);
	await runAtomic(env, queries);
	if (categoriesChanged.some((change) => change.to === 'active')) effects?.signalDispatch();
	const updated = await loadWorkflow(db, actor.userId, id);
	if (contextSweep.deleted.length > 0) updated.deleted_context = contextSweep.deleted;
	if (clearedInheritance.length > 0) updated.cleared_inheritance = clearedInheritance;
	return updated;
}

export async function deleteWorkflow(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	{ forceDeleteContext = false, forceClearInheritance = false } = {}
): Promise<{ deleted_context: DeletedContextItem[]; cleared_inheritance: ClearedInheritance[] }> {
	const wf = await loadWorkflow(db, actor.userId, id);
	if (wf.is_system) {
		throw new ApiFail(403, 'workflow_read_only', 'The standard workflow cannot be deleted');
	}
	if (wf.issue_count > 0) {
		throw new ApiFail(
			422,
			'workflow_in_use',
			`Cannot delete workflow "${wf.name}": ${wf.issue_count} issue${wf.issue_count === 1 ? '' : 's'} still reference it`,
			{ issue_count: wf.issue_count }
		);
	}
	// Extends the phase-one editing rules: schedules bind to a workflow.
	await assertWorkflowNotScheduled(db, wf.id, wf.name);
	// Context scoped to any of the workflow's states rejects deletion unless
	// forced (same posture as project deletion and state removal).
	const attached = await findAttachedContext(db, actor.userId, {
		stateIds: wf.states.map((s) => s.id)
	});
	const sweep = sweepAttachedContext(
		db,
		actor,
		attached,
		forceDeleteContext,
		`delete workflow "${wf.name}"`
	);
	// States in *other* workflows that inherit from this one: deleting it
	// would rewrite their prompts, so it is refused unless forced. Pointers
	// inside this workflow die with it and need no consent.
	const stateIds = wf.states.map((s) => s.id);
	const children = await inheritingChildren(db, actor.userId, stateIds, new Set(stateIds));
	if (children.length > 0 && !forceClearInheritance) {
		throw new ApiFail(
			422,
			'workflow_inherited',
			`Cannot delete workflow "${wf.name}": ${children.length} state${children.length === 1 ? ' in another workflow inherits' : 's in other workflows inherit'} context from it (${children.map((c) => `${c.workflowName} / ${c.name}`).join(', ')}): re-point them first, or pass force_clear_inheritance to clear their pointers`,
			{
				states: children.map((c) => ({
					state_id: c.id,
					state_name: c.name,
					workflow_id: c.workflowId,
					workflow_name: c.workflowName
				}))
			}
		);
	}
	const clearedInheritance = clearedInheritanceFor(children, (baseId) => {
		const base = wf.states.find((s) => s.id === baseId);
		return base ? `${wf.name} / ${base.name}` : baseId;
	});
	await runAtomic(env, [
		...sweep.queries,
		db
			.updateTable('project')
			.set({ default_workflow_id: null })
			.where('default_workflow_id', '=', id)
			.compile(),
		db.deleteFrom('workflow_transition').where('workflow_id', '=', id).compile(),
		// Same pre-null as a state removal: the self-FK has no ON DELETE action.
		db
			.updateTable('workflow_state')
			.set({ inherits_from_state_id: null })
			.where('inherits_from_state_id', 'in', stateIds)
			.compile(),
		db.deleteFrom('workflow_state').where('workflow_id', '=', id).compile(),
		db.deleteFrom('workflow').where('id', '=', id).compile(),
		eventInsert(db, actor, {
			type: 'workflow.deleted',
			payload: {
				workflow_id: id,
				name: wf.name,
				...(clearedInheritance.length
					? {
							inheritance_changed: clearedInheritance.map((c) => ({
								workflow: c.workflow_name,
								state: c.state_name,
								from: c.was,
								to: null
							}))
						}
					: {})
			}
		})
	]);
	return { deleted_context: sweep.deleted, cleared_inheritance: clearedInheritance };
}
