import {
	ARTIFACT_NAME_PATTERN,
	ARTIFACT_TYPES,
	STATE_CATEGORIES,
	STATE_PROMPT_NAME,
	type ArtifactRequirement,
	type ArtifactType,
	type CreateWorkflowRequest,
	type DeletedContextItem,
	type StateCategory,
	type UpdateWorkflowRequest,
	type WorkflowResponse,
	type WorkflowStateInput,
	type WorkflowTransitionInput
} from '@tines/shared';
import type { CompiledQuery, Kysely } from 'kysely';
import { newId, type Database, type WorkflowStateTable } from '$lib/server/db';
import { findAttachedContext, seedPromptQueries, sweepAttachedContext } from './context';
import {
	ApiFail,
	notFound,
	optionalString,
	requireString,
	runAtomic,
	type ActorContext
} from './core';
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
}

interface ResolvedDef {
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
		const state: ResolvedState = {
			id: input.id ?? newId('wfs'),
			name,
			category: input.category,
			position: i,
			isNew: input.id === undefined,
			prompt
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
	const seenPairs = new Set<string>();
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
		const pairKey = `${from.id}→${to.id}`;
		if (seenPairs.has(pairKey)) {
			throw new ApiFail(
				422,
				'duplicate_transition',
				`Transition "${from.name}" → "${to.name}" is listed more than once`
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
		seenPairs.add(pairKey);
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
				position: s.position
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
// Mutations

export async function createWorkflow(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	body: CreateWorkflowRequest
): Promise<WorkflowResponse> {
	const name = requireString(body.name, 'name', { max: 200 }).trim();
	const description = optionalString(body.description, 'description', { max: 10_000 }) ?? '';
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
				description,
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
				.values({
					id: t.id,
					workflow_id: id,
					name: t.name,
					from_state_id: t.from_state_id,
					to_state_id: t.to_state_id,
					requirements: t.requires ? JSON.stringify(t.requires) : null
				})
				.compile()
		),
		// Initial stage instructions ride along in the same transaction.
		...def.states
			.filter((s) => s.prompt !== undefined)
			.flatMap(
				(s) =>
					seedPromptQueries(db, actor, {
						name: STATE_PROMPT_NAME,
						body: s.prompt!,
						workflowStateId: s.id,
						label: `state ${s.name}`,
						now
					}).queries
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

	const name =
		body.name !== undefined ? requireString(body.name, 'name', { max: 200 }).trim() : current.name;
	const description =
		body.description !== undefined
			? (optionalString(body.description, 'description', { max: 10_000 }) ?? '')
			: current.description;

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
	// Transitions are identified by their (from, to) pair; a kept pair whose
	// action name changed counts as a rename.
	const oldByPair = new Map(
		current.transitions.map((t) => [`${t.from_state_id}→${t.to_state_id}`, t])
	);
	const newByPair = new Map(def.transitions.map((t) => [`${t.from_state_id}→${t.to_state_id}`, t]));
	const transitionsAdded = [...newByPair.keys()].filter((p) => !oldByPair.has(p)).length;
	const transitionsRemoved = [...oldByPair.keys()].filter((p) => !newByPair.has(p)).length;
	const transitionsRenamed = [...newByPair.entries()]
		.filter(([pair, t]) => oldByPair.has(pair) && oldByPair.get(pair)!.name !== t.name)
		.map(([pair, t]) => ({ from: oldByPair.get(pair)!.name, to: t.name }));
	const requirementsChanged = [...newByPair.entries()].some(([pair, t]) => {
		const old = oldByPair.get(pair);
		return old && JSON.stringify(old.requires ?? null) !== JSON.stringify(t.requires ?? null);
	});

	const payload: Record<string, unknown> = { workflow_id: id, name };
	if (name !== current.name) payload.renamed = { from: current.name, to: name };
	if (description !== current.description) payload.description_changed = true;
	if (statesAdded.length) payload.states_added = statesAdded;
	if (statesRemoved.length) payload.states_removed = statesRemoved;
	if (statesRenamed.length) payload.states_renamed = statesRenamed;
	if (categoriesChanged.length) payload.categories_changed = categoriesChanged;
	if (transitionsAdded) payload.transitions_added = transitionsAdded;
	if (transitionsRemoved) payload.transitions_removed = transitionsRemoved;
	if (transitionsRenamed.length) payload.transitions_renamed = transitionsRenamed;
	if (requirementsChanged) payload.transition_requirements_changed = true;
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
	queries.push(
		db
			.updateTable('workflow')
			.set({ name, description, initial_state_id: def.initialStateId, updated_at: now })
			.where('id', '=', id)
			.compile(),
		eventInsert(db, actor, { type: 'workflow.updated', payload })
	);
	await runAtomic(env, queries);
	const updated = await loadWorkflow(db, actor.userId, id);
	if (contextSweep.deleted.length > 0) updated.deleted_context = contextSweep.deleted;
	return updated;
}

export async function deleteWorkflow(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	{ forceDeleteContext = false } = {}
): Promise<DeletedContextItem[]> {
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
	await runAtomic(env, [
		...sweep.queries,
		db
			.updateTable('project')
			.set({ default_workflow_id: null })
			.where('default_workflow_id', '=', id)
			.compile(),
		db.deleteFrom('workflow_transition').where('workflow_id', '=', id).compile(),
		db.deleteFrom('workflow_state').where('workflow_id', '=', id).compile(),
		db.deleteFrom('workflow').where('id', '=', id).compile(),
		eventInsert(db, actor, {
			type: 'workflow.deleted',
			payload: { workflow_id: id, name: wf.name }
		})
	]);
	return sweep.deleted;
}
