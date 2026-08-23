import type { CreateProjectRequest, Project, UpdateProjectRequest } from '@tines/shared';
import type { Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { ApiFail, notFound, requireString, runAtomic, type ActorContext } from './core';
import { eventInsert } from './events';

function projectQuery(db: Kysely<Database>, userId: string) {
	return db
		.selectFrom('project')
		.selectAll('project')
		.select((eb) =>
			eb
				.selectFrom('issue')
				.whereRef('issue.project_id', '=', 'project.id')
				.select((eb2) => eb2.fn.countAll<number>().as('n'))
				.as('issue_count')
		)
		.where('project.user_id', '=', userId);
}

type ProjectRow = Awaited<ReturnType<ReturnType<typeof projectQuery>['execute']>>[number];

function serializeProject(row: ProjectRow): Project {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		default_workflow_id: row.default_workflow_id,
		created_at: row.created_at,
		updated_at: row.updated_at,
		issue_count: Number(row.issue_count ?? 0)
	};
}

export async function listProjects(db: Kysely<Database>, userId: string): Promise<Project[]> {
	const rows = await projectQuery(db, userId).orderBy('project.created_at asc').execute();
	return rows.map(serializeProject);
}

export async function getProject(
	db: Kysely<Database>,
	userId: string,
	id: string
): Promise<Project> {
	const row = await projectQuery(db, userId).where('project.id', '=', id).executeTakeFirst();
	if (!row) throw notFound();
	return serializeProject(row);
}

/** The referenced workflow must be the user's own or the system workflow. */
async function assertWorkflowAccessible(db: Kysely<Database>, userId: string, workflowId: string) {
	const wf = await db
		.selectFrom('workflow')
		.select('id')
		.where('id', '=', workflowId)
		.where((eb) => eb.or([eb('user_id', '=', userId), eb('user_id', 'is', null)]))
		.executeTakeFirst();
	if (!wf) {
		throw new ApiFail(422, 'unknown_workflow', `Workflow "${workflowId}" does not exist`, {
			field: 'default_workflow_id'
		});
	}
}

export async function createProject(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	body: CreateProjectRequest
): Promise<Project> {
	const name = requireString(body.name, 'name', { max: 200 }).trim();
	if (body.default_workflow_id) {
		await assertWorkflowAccessible(db, actor.userId, body.default_workflow_id);
	}
	const now = Date.now();
	const id = newId('prj');
	await runAtomic(env, [
		db
			.insertInto('project')
			.values({
				id,
				user_id: actor.userId,
				name,
				description: body.description ?? '',
				default_workflow_id: body.default_workflow_id ?? null,
				created_at: now,
				updated_at: now
			})
			.compile(),
		eventInsert(db, actor, { type: 'project.created', projectId: id, payload: { name } })
	]);
	return getProject(db, actor.userId, id);
}

export async function updateProject(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	body: UpdateProjectRequest
): Promise<Project> {
	const current = await getProject(db, actor.userId, id);
	const name = body.name !== undefined ? requireString(body.name, 'name', { max: 200 }).trim() : current.name;
	const description = body.description ?? current.description;
	const defaultWorkflowId =
		body.default_workflow_id !== undefined ? body.default_workflow_id : current.default_workflow_id;
	if (defaultWorkflowId) {
		await assertWorkflowAccessible(db, actor.userId, defaultWorkflowId);
	}

	const changed: string[] = [];
	if (name !== current.name) changed.push('name');
	if (description !== current.description) changed.push('description');
	if (defaultWorkflowId !== current.default_workflow_id) changed.push('default_workflow');

	await runAtomic(env, [
		db
			.updateTable('project')
			.set({ name, description, default_workflow_id: defaultWorkflowId, updated_at: Date.now() })
			.where('id', '=', id)
			.compile(),
		eventInsert(db, actor, {
			type: 'project.updated',
			projectId: id,
			payload: { name, changed, ...(name !== current.name ? { renamed: { from: current.name, to: name } } : {}) }
		})
	]);
	return getProject(db, actor.userId, id);
}

export async function deleteProject(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string
): Promise<void> {
	const project = await getProject(db, actor.userId, id);
	if (project.issue_count > 0) {
		throw new ApiFail(
			422,
			'project_not_empty',
			`Cannot delete project "${project.name}": it still contains ${project.issue_count} issue${project.issue_count === 1 ? '' : 's'}`,
			{ issue_count: project.issue_count }
		);
	}
	await runAtomic(env, [
		db.deleteFrom('project').where('id', '=', id).compile(),
		// project_id stays null-able on the event so the feed keeps history
		// for deleted projects; record the name in the payload.
		eventInsert(db, actor, { type: 'project.deleted', payload: { project_id: id, name: project.name } })
	]);
}
