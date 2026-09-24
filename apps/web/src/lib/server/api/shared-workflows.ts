import type { WorkflowResponse } from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { notFound, type ActorContext } from './core';
import { resolveProjectAccess } from './project-access';
import { projectReadPredicate } from './permissions';

/** A workflow is visible only through a current member project that uses it. */
const usedByMemberProject = (actor: ActorContext) => sql<boolean>`EXISTS (
	SELECT 1 FROM project p JOIN project_member m ON m.project_id = p.id
	WHERE m.user_id = ${actor.userId} AND m.revoked_at IS NULL AND p.shared_at IS NOT NULL
	AND ${projectReadPredicate(actor, 'p.id')}
	AND p.user_id != ${actor.userId} AND (
		p.default_workflow_id = w.id OR
		EXISTS (SELECT 1 FROM issue i WHERE i.project_id = p.id AND i.workflow_id = w.id) OR
		EXISTS (SELECT 1 FROM scheduled_task s WHERE s.project_id = p.id AND s.workflow_id = w.id)
	))`;

export async function listSharedWorkflows(
	db: Kysely<Database>,
	actor: ActorContext
): Promise<WorkflowResponse[]> {
	if (actor.agentRunId) return [];
	const rows = await db
		.selectFrom('workflow as w')
		.select('w.id')
		.where(usedByMemberProject(actor))
		.orderBy('w.created_at')
		.execute();
	return Promise.all(rows.map((row) => readSharedWorkflow(db, actor, row.id)));
}

export async function readSharedWorkflow(
	db: Kysely<Database>,
	actor: ActorContext,
	workflowId: string
): Promise<WorkflowResponse> {
	if (actor.agentRunId) throw notFound();
	const row = await db
		.selectFrom('workflow as w')
		.select([
			'w.id',
			'w.name',
			'w.description',
			'w.user_id',
			'w.initial_state_id',
			'w.created_at',
			'w.updated_at'
		])
		.where('w.id', '=', workflowId)
		.where(usedByMemberProject(actor))
		.executeTakeFirst();
	if (!row) throw notFound();
	const source = await db
		.selectFrom('project as p')
		.innerJoin('project_member as m', (join) =>
			join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', actor.userId)
		)
		.select(['p.id', 'm.revision'])
		.where('m.revoked_at', 'is', null)
		.where('p.shared_at', 'is not', null)
		.where(projectReadPredicate(actor, 'p.id'))
		.where((eb) =>
			eb.or([
				eb('p.default_workflow_id', '=', workflowId),
				eb.exists(
					eb
						.selectFrom('issue')
						.select('id')
						.whereRef('project_id', '=', 'p.id')
						.where('workflow_id', '=', workflowId)
				),
				eb.exists(
					eb
						.selectFrom('scheduled_task')
						.select('id')
						.whereRef('project_id', '=', 'p.id')
						.where('workflow_id', '=', workflowId)
				)
			])
		)
		.executeTakeFirst();
	if (!source) throw notFound();
	const [states, transitions, count] = await Promise.all([
		db
			.selectFrom('workflow_state')
			.select(['id', 'name', 'category', 'position', 'inherits_from_state_id'])
			.where('workflow_id', '=', workflowId)
			.orderBy('position')
			.execute(),
		db
			.selectFrom('workflow_transition')
			.select(['id', 'name', 'from_state_id', 'to_state_id', 'requirements'])
			.where('workflow_id', '=', workflowId)
			.execute(),
		db
			.selectFrom('issue as i')
			.innerJoin('project as p', 'p.id', 'i.project_id')
			.innerJoin('project_member as m', (join) =>
				join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', actor.userId)
			)
			.select((eb) => eb.fn.countAll<number>().as('n'))
			.where('i.workflow_id', '=', workflowId)
			.where('m.revoked_at', 'is', null)
			.where('p.shared_at', 'is not', null)
			.executeTakeFirst()
	]);
	const current = await resolveProjectAccess(db, actor, source.id);
	if (current.membershipRevision !== source.revision) throw notFound();
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		is_system: row.user_id === null,
		initial_state_id: row.initial_state_id,
		states: states.map((state) => ({
			id: state.id,
			name: state.name,
			category: state.category,
			position: state.position,
			inherits_from: state.inherits_from_state_id
		})),
		transitions: transitions.map((transition) => ({
			id: transition.id,
			name: transition.name,
			from_state_id: transition.from_state_id,
			to_state_id: transition.to_state_id,
			...(transition.requirements ? { requires: JSON.parse(transition.requirements) } : {})
		})),
		issue_count: Number(count?.n ?? 0),
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}
