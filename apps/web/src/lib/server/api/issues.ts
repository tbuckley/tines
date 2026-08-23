import {
	renderTemplate,
	templateVars,
	type AllowedTransition,
	type Comment,
	type CreateCommentRequest,
	type CreateIssueRequest,
	type CreateIssueResponse,
	type Issue,
	type IssueDetail,
	type StateCategory,
	type TransitionIssueRequest,
	type UpdateIssueRequest,
	type WorkflowResponse,
	type WorkflowState
} from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import {
	ApiFail,
	notFound,
	optionalString,
	requireString,
	runAtomic,
	type ActorContext,
	type Page
} from './core';
import { actorOf, eventInsert } from './events';
import { getSchedule, prepareSchedule } from './schedules';
import { loadWorkflow } from './workflows';

export function issueQuery(db: Kysely<Database>, userId: string) {
	return db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.innerJoin('workflow_state as state', 'state.id', 'issue.state_id')
		.leftJoin('scheduled_task', 'scheduled_task.id', 'issue.scheduled_task_id')
		.selectAll('issue')
		.select([
			'project.name as project_name',
			'state.name as state_name',
			'state.category as state_category',
			'state.position as state_position',
			'scheduled_task.name as scheduled_task_name'
		])
		.select((eb) =>
			eb
				.selectFrom('event')
				.whereRef('event.issue_id', '=', 'issue.id')
				.select((eb2) => eb2.fn.max('event.created_at').as('m'))
				.as('last_event_at')
		)
		.where('project.user_id', '=', userId);
}

type IssueRow = Awaited<ReturnType<ReturnType<typeof issueQuery>['execute']>>[number];

export function serializeIssue(row: IssueRow): Issue {
	return {
		id: row.id,
		project_id: row.project_id,
		project_name: row.project_name,
		number: row.number,
		title: row.title,
		description: row.description,
		workflow_id: row.workflow_id,
		state: {
			id: row.state_id,
			name: row.state_name,
			category: row.state_category,
			position: row.state_position
		},
		scheduled_task_id: row.scheduled_task_id,
		scheduled_task_name: row.scheduled_task_name,
		created_at: row.created_at,
		updated_at: row.updated_at,
		last_activity_at: Number(row.last_event_at ?? row.created_at)
	};
}

export interface IssueListFilters {
	project?: string;
	state?: string;
	category?: string;
	workflow?: string;
	/** Schedule id: only issues created by that scheduled task. */
	schedule?: string;
	hideDone?: boolean;
	/** Restrict to one project id (the nested per-project route). */
	projectId?: string;
}

export async function listIssues(
	db: Kysely<Database>,
	userId: string,
	filters: IssueListFilters,
	page: Page
): Promise<{ items: Issue[]; hasMore: boolean }> {
	let q = issueQuery(db, userId);
	if (filters.projectId) q = q.where('issue.project_id', '=', filters.projectId);
	if (filters.project) {
		const p = filters.project;
		q = q.where((eb) => eb.or([eb('project.id', '=', p), eb('project.name', '=', p)]));
	}
	if (filters.state) {
		const s = filters.state;
		q = q.where((eb) => eb.or([eb('state.id', '=', s), eb('state.name', '=', s)]));
	}
	if (filters.category) {
		q = q.where('state.category', '=', filters.category as StateCategory);
	}
	if (filters.workflow) {
		const w = filters.workflow;
		q = q.where((eb) =>
			eb.or([
				eb('issue.workflow_id', '=', w),
				eb(
					'issue.workflow_id',
					'in',
					eb
						.selectFrom('workflow')
						.select('id')
						.where('name', '=', w)
						// Only the user's own workflows (or the system one) can
						// match by name — never another user's.
						.where((eb2) => eb2.or([eb2('user_id', '=', userId), eb2('user_id', 'is', null)]))
				)
			])
		);
	}
	if (filters.schedule) q = q.where('issue.scheduled_task_id', '=', filters.schedule);
	if (filters.hideDone) q = q.where('state.category', '!=', 'done');
	if (page.cursor) {
		const { createdAt, id } = page.cursor;
		q = q.where((eb) =>
			eb.or([
				eb('issue.created_at', '<', createdAt),
				eb.and([eb('issue.created_at', '=', createdAt), eb('issue.id', '<', id)])
			])
		);
	}
	const rows = await q
		.orderBy('issue.created_at desc')
		.orderBy('issue.id desc')
		.limit(page.limit + 1)
		.execute();
	return { items: rows.slice(0, page.limit).map(serializeIssue), hasMore: rows.length > page.limit };
}

// ---------------------------------------------------------------------------
// Detail

export function allowedTransitions(
	workflow: WorkflowResponse,
	fromStateId: string
): AllowedTransition[] {
	const stateById = new Map(workflow.states.map((s) => [s.id, s]));
	return workflow.transitions
		.filter((t) => t.from_state_id === fromStateId)
		.flatMap((t) => {
			const toState = stateById.get(t.to_state_id);
			return toState ? [{ transition_id: t.id, name: t.name, to_state: toState }] : [];
		});
}

/** Resolves a state reference (id or name) within a workflow, or 422s. */
export function resolveStateRef(
	workflow: WorkflowResponse,
	ref: string,
	field = 'state'
): WorkflowState {
	const state = workflow.states.find((s) => s.id === ref) ?? workflow.states.find((s) => s.name === ref);
	if (!state) {
		throw new ApiFail(
			422,
			'unknown_state',
			`Workflow "${workflow.name}" has no state "${ref}"`,
			{ field, known_states: workflow.states.map((s) => ({ id: s.id, name: s.name })) }
		);
	}
	return state;
}

async function loadComments(db: Kysely<Database>, issueId: string): Promise<Comment[]> {
	const rows = await db
		.selectFrom('comment')
		.innerJoin('user as actor_user', 'actor_user.id', 'comment.actor_user_id')
		.leftJoin('api_key', 'api_key.id', 'comment.actor_api_key_id')
		.selectAll('comment')
		.select(['actor_user.name as actor_user_name', 'api_key.name as actor_api_key_name'])
		.where('comment.issue_id', '=', issueId)
		.orderBy('comment.created_at asc')
		.orderBy('comment.id asc')
		.execute();
	return rows.map((row) => ({
		id: row.id,
		issue_id: row.issue_id,
		body: row.body,
		actor: actorOf(row),
		created_at: row.created_at
	}));
}

export async function getIssueDetail(
	db: Kysely<Database>,
	userId: string,
	ref: { id: string } | { projectId: string; number: number }
): Promise<IssueDetail> {
	let q = issueQuery(db, userId);
	q =
		'id' in ref
			? q.where('issue.id', '=', ref.id)
			: q.where('issue.project_id', '=', ref.projectId).where('issue.number', '=', ref.number);
	const row = await q.executeTakeFirst();
	if (!row) throw notFound();

	const issue = serializeIssue(row);
	const [workflow, comments] = await Promise.all([
		loadWorkflow(db, userId, issue.workflow_id),
		loadComments(db, issue.id)
	]);
	return {
		...issue,
		workflow,
		comments,
		allowed_transitions: allowedTransitions(workflow, issue.state.id)
	};
}

// ---------------------------------------------------------------------------
// Mutations

export async function createIssue(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	body: CreateIssueRequest
): Promise<CreateIssueResponse> {
	const project = await db
		.selectFrom('project')
		.selectAll()
		.where('id', '=', projectId)
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!project) throw notFound();

	const title = requireString(body.title, 'title', { max: 500 }).trim();
	const description = optionalString(body.description, 'description') ?? '';

	const workflowId = body.workflow_id ?? project.default_workflow_id ?? 'wf_standard';
	const workflow = await loadWorkflow(db, actor.userId, workflowId).catch(() => {
		throw new ApiFail(422, 'unknown_workflow', `Workflow "${workflowId}" does not exist`, {
			field: 'workflow_id'
		});
	});
	const initialState = body.state
		? resolveStateRef(workflow, requireString(body.state, 'state', { max: 100 }).trim())
		: resolveStateRef(workflow, workflow.initial_state_id);

	const now = Date.now();
	const id = newId('iss');

	// With a recurrence, the title/description double as the schedule's
	// templates: the first issue is created immediately (placeholders
	// rendered) and the schedule takes over from there.
	const schedule = body.schedule ? await prepareSchedule(db, projectId, body.schedule, title, now) : null;
	const vars = schedule ? templateVars(schedule.name, 1, schedule.timezone, now) : null;
	const issueTitle = vars ? renderTemplate(title, vars) : title;
	const issueDescription = vars ? renderTemplate(description, vars) : description;

	const queries: CompiledQuery[] = [];
	if (schedule) {
		queries.push(
			db
				.insertInto('scheduled_task')
				.values({
					id: schedule.id,
					project_id: projectId,
					name: schedule.name,
					title_template: title,
					description_template: description,
					workflow_id: workflow.id,
					cron: schedule.recurrence.cron,
					preset: schedule.recurrence.presetJson,
					timezone: schedule.timezone,
					require_all_closed: schedule.requireAllClosed ? 1 : 0,
					enabled: 1,
					next_run_at: schedule.nextRunAt,
					last_run_at: now,
					// The initial issue counts as the first run.
					run_count: 1,
					created_at: now,
					updated_at: now
				})
				.compile()
		);
	}
	queries.push(
		// MAX(number)+1 inside a single statement (and the batch's implicit
		// transaction) keeps per-project numbering race-free on D1.
		db
			.insertInto('issue')
			.values({
				id,
				project_id: projectId,
				number: sql<number>`(SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE project_id = ${projectId})`,
				title: issueTitle,
				description: issueDescription,
				workflow_id: workflow.id,
				state_id: initialState.id,
				scheduled_task_id: schedule?.id ?? null,
				created_at: now,
				updated_at: now
			})
			.compile(),
		eventInsert(db, actor, {
			type: 'issue.created',
			issueId: id,
			projectId,
			payload: {
				title: issueTitle,
				workflow_id: workflow.id,
				state_id: initialState.id,
				state_name: initialState.name,
				...(schedule ? { scheduled_task_id: schedule.id, scheduled_task_name: schedule.name } : {})
			}
		})
	);
	if (schedule) {
		queries.push(
			eventInsert(db, actor, {
				type: 'scheduled_task.created',
				projectId,
				payload: {
					schedule_id: schedule.id,
					name: schedule.name,
					cron: schedule.recurrence.cron,
					timezone: schedule.timezone,
					require_all_closed: schedule.requireAllClosed
				}
			})
		);
	}
	await runAtomic(env, queries);

	const issue = await getIssueDetail(db, actor.userId, { id });
	if (!schedule) return issue;
	return { ...issue, schedule: await getSchedule(db, actor.userId, schedule.id) };
}

export async function updateIssue(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	body: UpdateIssueRequest
): Promise<IssueDetail> {
	const current = await getIssueDetail(db, actor.userId, { id });
	const title = body.title !== undefined ? requireString(body.title, 'title', { max: 500 }).trim() : current.title;
	const description =
		body.description !== undefined ? (optionalString(body.description, 'description') ?? '') : current.description;

	// Workflow move and forced state set: the escape hatch beside
	// transitionIssue's guarded moves.
	let workflow = current.workflow;
	if (body.workflow_id !== undefined) {
		const ref = requireString(body.workflow_id, 'workflow_id', { max: 100 }).trim();
		if (ref !== current.workflow.id) {
			workflow = await loadWorkflow(db, actor.userId, ref).catch(() => {
				throw new ApiFail(422, 'unknown_workflow', `Workflow "${ref}" does not exist`, {
					field: 'workflow_id'
				});
			});
		}
	}
	const workflowChanged = workflow.id !== current.workflow.id;
	let nextState = current.state;
	if (body.state !== undefined) {
		nextState = resolveStateRef(workflow, requireString(body.state, 'state', { max: 100 }).trim());
	} else if (workflowChanged) {
		nextState = resolveStateRef(workflow, workflow.initial_state_id);
	}
	const stateChanged = nextState.id !== current.state.id;

	const changed: string[] = [];
	if (title !== current.title) changed.push('title');
	if (description !== current.description) changed.push('description');
	if (workflowChanged) changed.push('workflow');
	if (changed.length === 0 && !stateChanged) return current;

	// Compare-and-swap on the state whenever it (or the workflow) moves, so a
	// concurrent transition can't be silently overwritten; the events are
	// guarded on the same write landing.
	const now = Date.now();
	const guarded = stateChanged || workflowChanged;
	let update = db
		.updateTable('issue')
		.set({ title, description, workflow_id: workflow.id, state_id: nextState.id, updated_at: now })
		.where('id', '=', id);
	if (guarded) update = update.where('state_id', '=', current.state.id);
	const guard = guarded ? { issueId: id, stateId: nextState.id, updatedAt: now } : undefined;

	const queries: CompiledQuery[] = [update.compile()];
	if (changed.length > 0) {
		const payload: Record<string, unknown> = { changed, title };
		if (workflowChanged) {
			payload.workflow_from_id = current.workflow.id;
			payload.workflow_from_name = current.workflow.name;
			payload.workflow_to_id = workflow.id;
			payload.workflow_to_name = workflow.name;
			payload.from_state_name = current.state.name;
			payload.to_state_name = nextState.name;
		}
		queries.push(
			eventInsert(db, actor, { type: 'issue.updated', issueId: id, projectId: current.project_id, payload }, guard)
		);
	}
	if (stateChanged && !workflowChanged) {
		queries.push(
			eventInsert(
				db,
				actor,
				{
					type: 'issue.transitioned',
					issueId: id,
					projectId: current.project_id,
					payload: {
						forced: true,
						from_state_id: current.state.id,
						from_state_name: current.state.name,
						to_state_id: nextState.id,
						to_state_name: nextState.name
					}
				},
				guard
			)
		);
	}

	const results = await runAtomic(env, queries);
	if (guarded && (results[0]?.meta.changes ?? 0) === 0) {
		const fresh = await getIssueDetail(db, actor.userId, { id });
		throw new ApiFail(
			409,
			'conflict',
			`The issue moved to state "${fresh.state.name}" while this update was in flight; re-check and retry`,
			{ current_state: fresh.state, allowed_transitions: fresh.allowed_transitions }
		);
	}
	return getIssueDetail(db, actor.userId, { id });
}

export async function transitionIssue(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	body: TransitionIssueRequest
): Promise<IssueDetail> {
	const current = await getIssueDetail(db, actor.userId, { id });

	const action = body.action?.trim();
	const transitionId = body.transition_id?.trim();
	if ((action ? 1 : 0) + (transitionId ? 1 : 0) !== 1) {
		throw new ApiFail(
			422,
			'invalid_field',
			'Pass exactly one of "action" (the transition name) or "transition_id"'
		);
	}

	const allowed = current.allowed_transitions;
	const target = transitionId
		? allowed.find((t) => t.transition_id === transitionId)
		: allowed.find((t) => t.name.toLowerCase() === action!.toLowerCase());
	if (!target) {
		const what = transitionId ? `Transition "${transitionId}"` : `Action "${action}"`;
		throw new ApiFail(
			422,
			'invalid_transition',
			`${what} is not available from state "${current.state.name}" in workflow "${current.workflow.name}"${
				allowed.length
					? `; allowed: ${allowed.map((t) => `"${t.name}" (→ ${t.to_state.name})`).join(', ')}`
					: '; this state is terminal'
			}`,
			{
				current_state: current.state,
				allowed_transitions: allowed
			}
		);
	}

	// Compare-and-swap: the update only applies while the issue is still in
	// the state the transition was validated against, and the event insert is
	// guarded on that same write landing — a lost race records nothing.
	const now = Date.now();
	const results = await runAtomic(env, [
		db
			.updateTable('issue')
			.set({ state_id: target.to_state.id, updated_at: now })
			.where('id', '=', id)
			.where('state_id', '=', current.state.id)
			.compile(),
		eventInsert(
			db,
			actor,
			{
				type: 'issue.transitioned',
				issueId: id,
				projectId: current.project_id,
				payload: {
					transition_id: target.transition_id,
					action: target.name,
					from_state_id: current.state.id,
					from_state_name: current.state.name,
					to_state_id: target.to_state.id,
					to_state_name: target.to_state.name
				}
			},
			{ issueId: id, stateId: target.to_state.id, updatedAt: now }
		)
	]);
	if ((results[0]?.meta.changes ?? 0) === 0) {
		const fresh = await getIssueDetail(db, actor.userId, { id });
		throw new ApiFail(
			409,
			'conflict',
			`The issue moved to state "${fresh.state.name}" while this transition was in flight; re-check the allowed transitions`,
			{ current_state: fresh.state, allowed_transitions: fresh.allowed_transitions }
		);
	}
	return getIssueDetail(db, actor.userId, { id });
}

export async function createComment(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	body: CreateCommentRequest
): Promise<Comment> {
	const issue = await getIssueDetail(db, actor.userId, { id: issueId });
	const text = requireString(body.body, 'body', { max: 100_000 });

	const id = newId('cmt');
	await runAtomic(env, [
		db
			.insertInto('comment')
			.values({
				id,
				issue_id: issue.id,
				body: text,
				actor_user_id: actor.userId,
				actor_api_key_id: actor.apiKeyId,
				created_at: Date.now()
			})
			.compile(),
		eventInsert(db, actor, {
			type: 'issue.commented',
			issueId: issue.id,
			projectId: issue.project_id,
			payload: { comment_id: id }
		})
	]);
	const comments = await loadComments(db, issue.id);
	const created = comments.find((c) => c.id === id);
	if (!created) throw new ApiFail(500, 'internal', 'Comment insert failed');
	return created;
}

export { loadComments };
