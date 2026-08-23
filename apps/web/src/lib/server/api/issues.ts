import type {
	Comment,
	CreateCommentRequest,
	CreateIssueRequest,
	Issue,
	IssueDetail,
	StateCategory,
	UpdateIssueRequest,
	WorkflowResponse
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
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
import { loadWorkflow } from './workflows';

export function issueQuery(db: Kysely<Database>, userId: string) {
	return db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.innerJoin('workflow_state as state', 'state.id', 'issue.state_id')
		.selectAll('issue')
		.select([
			'project.name as project_name',
			'state.name as state_name',
			'state.category as state_category',
			'state.position as state_position'
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
				eb('issue.workflow_id', 'in', eb.selectFrom('workflow').select('id').where('name', '=', w))
			])
		);
	}
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

export function allowedTransitions(workflow: WorkflowResponse, fromStateId: string) {
	const targets = new Set(
		workflow.transitions.filter((t) => t.from_state_id === fromStateId).map((t) => t.to_state_id)
	);
	return workflow.states.filter((s) => targets.has(s.id));
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
): Promise<IssueDetail> {
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

	const now = Date.now();
	const id = newId('iss');
	await runAtomic(env, [
		// MAX(number)+1 inside a single statement (and the batch's implicit
		// transaction) keeps per-project numbering race-free on D1.
		db
			.insertInto('issue')
			.values({
				id,
				project_id: projectId,
				number: sql<number>`(SELECT COALESCE(MAX(number), 0) + 1 FROM issue WHERE project_id = ${projectId})`,
				title,
				description,
				workflow_id: workflow.id,
				state_id: workflow.initial_state_id,
				created_at: now,
				updated_at: now
			})
			.compile(),
		eventInsert(db, actor, {
			type: 'issue.created',
			issueId: id,
			projectId,
			payload: { title, workflow_id: workflow.id }
		})
	]);
	return getIssueDetail(db, actor.userId, { id });
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

	const changed: string[] = [];
	if (title !== current.title) changed.push('title');
	if (description !== current.description) changed.push('description');
	if (changed.length === 0) return current;

	await runAtomic(env, [
		db
			.updateTable('issue')
			.set({ title, description, updated_at: Date.now() })
			.where('id', '=', id)
			.compile(),
		eventInsert(db, actor, {
			type: 'issue.updated',
			issueId: id,
			projectId: current.project_id,
			payload: { changed, title }
		})
	]);
	return getIssueDetail(db, actor.userId, { id });
}

export async function transitionIssue(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	toStateId: string
): Promise<IssueDetail> {
	const current = await getIssueDetail(db, actor.userId, { id });
	requireString(toStateId, 'to_state_id');

	const allowed = current.allowed_transitions;
	const target = allowed.find((s) => s.id === toStateId);
	if (!target) {
		const toState = current.workflow.states.find((s) => s.id === toStateId);
		throw new ApiFail(
			422,
			'invalid_transition',
			toState
				? `"${current.state.name}" → "${toState.name}" is not a transition in workflow "${current.workflow.name}"`
				: `State "${toStateId}" is not part of workflow "${current.workflow.name}"`,
			{
				current_state: current.state,
				allowed_transitions: allowed
			}
		);
	}

	await runAtomic(env, [
		db
			.updateTable('issue')
			.set({ state_id: target.id, updated_at: Date.now() })
			.where('id', '=', id)
			.compile(),
		eventInsert(db, actor, {
			type: 'issue.transitioned',
			issueId: id,
			projectId: current.project_id,
			payload: {
				from_state_id: current.state.id,
				from_state_name: current.state.name,
				to_state_id: target.id,
				to_state_name: target.name
			}
		})
	]);
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
