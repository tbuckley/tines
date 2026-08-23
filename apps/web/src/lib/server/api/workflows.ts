import {
	STATE_CATEGORIES,
	type CreateWorkflowRequest,
	type StateCategory,
	type UpdateWorkflowRequest,
	type WorkflowResponse,
	type WorkflowStateInput,
	type WorkflowTransitionInput
} from '@tines/shared';
import type { CompiledQuery, Kysely } from 'kysely';
import { newId, type Database, type WorkflowStateTable } from '$lib/server/db';
import { ApiFail, notFound, requireString, runAtomic, type ActorContext } from './core';
import { eventInsert } from './events';

interface ResolvedState {
	id: string;
	name: string;
	category: StateCategory;
	position: number;
	isNew: boolean;
}

interface ResolvedDef {
	states: ResolvedState[];
	transitions: { id: string; from_state_id: string; to_state_id: string }[];
	initialStateId: string;
}

/**
 * Validates state/transition inputs and resolves name-or-id references.
 * Enforces: ≥1 state, unique non-empty names, valid categories, initial
 * state categorized backlog/active, transitions between known states, no
 * self-transitions, no duplicates.
 */
function resolveDef(
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
			throw new ApiFail(422, 'unknown_state', `State id "${input.id}" is not part of this workflow`);
		}
		const state: ResolvedState = {
			id: input.id ?? newId('wfs'),
			name,
			category: input.category,
			position: i,
			isNew: input.id === undefined
		};
		if (byId.has(state.id)) {
			throw new ApiFail(422, 'duplicate_state', `State id "${state.id}" is listed more than once`);
		}
		states.push(state);
		byName.set(name, state);
		byId.set(state.id, state);
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
	const seen = new Set<string>();
	for (const [i, t] of (transitionsInput ?? []).entries()) {
		const from = resolveRef(requireString(t.from, `transitions[${i}].from`), `transitions[${i}]`);
		const to = resolveRef(requireString(t.to, `transitions[${i}].to`), `transitions[${i}]`);
		if (from.id === to.id) {
			throw new ApiFail(
				422,
				'self_transition',
				`Transition ${i} loops "${from.name}" onto itself; self-transitions are not allowed`
			);
		}
		const key = `${from.id}→${to.id}`;
		if (seen.has(key)) {
			throw new ApiFail(
				422,
				'duplicate_transition',
				`Transition "${from.name}" → "${to.name}" is listed more than once`
			);
		}
		seen.add(key);
		transitions.push({ id: newId('wft'), from_state_id: from.id, to_state_id: to.id });
	}

	return { states, transitions, initialStateId: initial.id };
}

/** Non-fatal advisories: a non-done state with no way out is probably a bug. */
function deadEndWarnings(def: {
	states: Pick<ResolvedState, 'id' | 'name' | 'category'>[];
	transitions: { from_state_id: string }[];
}): string[] {
	const hasOutgoing = new Set(def.transitions.map((t) => t.from_state_id));
	return def.states
		.filter((s) => s.category !== 'done' && !hasOutgoing.has(s.id))
		.map((s) => `State "${s.name}" is not categorized "done" but has no outgoing transitions — issues that reach it will be stuck.`);
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
				.whereRef('issue.workflow_id', '=', 'workflow.id')
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
				position: s.position
			})),
			transitions: wfTransitions.map((t) => ({
				id: t.id,
				from_state_id: t.from_state_id,
				to_state_id: t.to_state_id
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
// Mutations

export async function createWorkflow(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	body: CreateWorkflowRequest
): Promise<WorkflowResponse> {
	const name = requireString(body.name, 'name', { max: 200 }).trim();
	const def = resolveDef(body.states, body.transitions ?? [], body.initial_state, []);

	const now = Date.now();
	const id = newId('wf');
	const queries: CompiledQuery[] = [
		db
			.insertInto('workflow')
			.values({
				id,
				user_id: actor.userId,
				name,
				description: body.description ?? '',
				initial_state_id: def.initialStateId,
				created_at: now,
				updated_at: now
			})
			.compile(),
		...def.states.map((s) =>
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
		),
		...def.transitions.map((t) =>
			db
				.insertInto('workflow_transition')
				.values({ id: t.id, workflow_id: id, from_state_id: t.from_state_id, to_state_id: t.to_state_id })
				.compile()
		),
		eventInsert(db, actor, { type: 'workflow.created', payload: { workflow_id: id, name } })
	];
	await runAtomic(env, queries);
	return loadWorkflow(db, actor.userId, id);
}

export async function updateWorkflow(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	body: UpdateWorkflowRequest
): Promise<WorkflowResponse> {
	const current = await loadWorkflow(db, actor.userId, id);
	if (current.is_system) {
		throw new ApiFail(
			403,
			'workflow_read_only',
			'The standard workflow is read-only; copy it into your library to make changes'
		);
	}

	const name = body.name !== undefined ? requireString(body.name, 'name', { max: 200 }).trim() : current.name;
	const description = body.description ?? current.description;

	const statesInput: WorkflowStateInput[] =
		body.states ?? current.states.map((s) => ({ id: s.id, name: s.name, category: s.category }));
	const transitionsInput: WorkflowTransitionInput[] =
		body.transitions ??
		current.transitions.map((t) => ({ from: t.from_state_id, to: t.to_state_id }));
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
	const keptIds = new Set(def.states.map((s) => s.id));
	const removedStates = current.states.filter((s) => !keptIds.has(s.id));
	if (removedStates.length > 0) {
		const occupied = await db
			.selectFrom('issue')
			.select(['state_id', (eb) => eb.fn.countAll<number>().as('n')])
			.where('state_id', 'in', removedStates.map((s) => s.id))
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

	// Summary diff for the workflow.updated event payload.
	const currentById = new Map(current.states.map((s) => [s.id, s]));
	const statesAdded = def.states.filter((s) => s.isNew).map((s) => s.name);
	const statesRemoved = removedStates.map((s) => s.name);
	const statesRenamed = def.states
		.filter((s) => !s.isNew && currentById.get(s.id) && currentById.get(s.id)!.name !== s.name)
		.map((s) => ({ from: currentById.get(s.id)!.name, to: s.name }));
	const categoriesChanged = def.states
		.filter((s) => !s.isNew && currentById.get(s.id) && currentById.get(s.id)!.category !== s.category)
		.map((s) => ({ state: s.name, from: currentById.get(s.id)!.category, to: s.category }));
	const oldPairs = new Set(current.transitions.map((t) => `${t.from_state_id}→${t.to_state_id}`));
	const newPairs = new Set(def.transitions.map((t) => `${t.from_state_id}→${t.to_state_id}`));
	const transitionsAdded = [...newPairs].filter((p) => !oldPairs.has(p)).length;
	const transitionsRemoved = [...oldPairs].filter((p) => !newPairs.has(p)).length;

	const payload: Record<string, unknown> = { workflow_id: id, name };
	if (name !== current.name) payload.renamed = { from: current.name, to: name };
	if (description !== current.description) payload.description_changed = true;
	if (statesAdded.length) payload.states_added = statesAdded;
	if (statesRemoved.length) payload.states_removed = statesRemoved;
	if (statesRenamed.length) payload.states_renamed = statesRenamed;
	if (categoriesChanged.length) payload.categories_changed = categoriesChanged;
	if (transitionsAdded) payload.transitions_added = transitionsAdded;
	if (transitionsRemoved) payload.transitions_removed = transitionsRemoved;
	if (def.initialStateId !== current.initial_state_id) {
		payload.initial_changed = {
			from: currentById.get(current.initial_state_id)?.name,
			to: def.states.find((s) => s.id === def.initialStateId)?.name
		};
	}

	const now = Date.now();
	const queries: CompiledQuery[] = [];
	// Old transitions go first: they hold foreign keys onto states about to
	// be deleted. Transition ids are not referenced elsewhere, so the set is
	// replaced wholesale.
	queries.push(db.deleteFrom('workflow_transition').where('workflow_id', '=', id).compile());
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
				.values({ id: t.id, workflow_id: id, from_state_id: t.from_state_id, to_state_id: t.to_state_id })
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
	return loadWorkflow(db, actor.userId, id);
}

export async function deleteWorkflow(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string
): Promise<void> {
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
	await runAtomic(env, [
		db
			.updateTable('project')
			.set({ default_workflow_id: null })
			.where('default_workflow_id', '=', id)
			.compile(),
		db.deleteFrom('workflow_transition').where('workflow_id', '=', id).compile(),
		db.deleteFrom('workflow_state').where('workflow_id', '=', id).compile(),
		db.deleteFrom('workflow').where('id', '=', id).compile(),
		eventInsert(db, actor, { type: 'workflow.deleted', payload: { workflow_id: id, name: wf.name } })
	]);
}
