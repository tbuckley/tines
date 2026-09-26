import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import type { ActorContext } from './core';
import { resolveProjectAccess, runProjectActor } from './project-access';
import { notFound } from './core';
import { projectReadPredicate } from './permissions';

/** Explicit member projection: no owner account fields. */
export async function readSharedProject(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string
) {
	const access = await resolveProjectAccess(db, actor, projectId);
	const row = await db
		.selectFrom('project as p')
		.innerJoin('user as owner', 'owner.id', 'p.user_id')
		.select([
			'p.id',
			'p.name',
			'p.description',
			'p.created_at',
			'p.updated_at',
			'p.archived_at',
			'p.shared_at',
			'p.sharing_revision',
			'p.default_workflow_id',
			'owner.id as owner_id',
			'owner.name as owner_name'
		])
		.select((eb) =>
			eb
				.selectFrom('issue')
				.select((b) => b.fn.countAll<number>().as('n'))
				.whereRef('issue.project_id', '=', 'p.id')
				.as('issue_count')
		)
		.where('p.id', '=', projectId)
		.executeTakeFirstOrThrow();
	if (
		access.role === 'member' &&
		(await resolveProjectAccess(db, actor, projectId)).membershipRevision !==
			access.membershipRevision
	)
		throw notFound();
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		default_workflow_id: row.default_workflow_id,
		owner: { id: row.owner_id, name: row.owner_name },
		viewer_role: access.role,
		archived_at: row.archived_at,
		shared_at: row.shared_at,
		sharing_revision: row.sharing_revision,
		created_at: row.created_at,
		updated_at: row.updated_at,
		issue_count: Number(row.issue_count),
		capabilities: {
			read: true,
			invite: access.role === 'owner',
			create_issue: true,
			leave: access.role === 'member'
		}
	};
}

export async function listSharedProjects(
	db: Kysely<Database>,
	actor: ActorContext,
	archived: 'false' | 'true' | 'all' = 'false'
) {
	// A member run lists only its admitted project, at the revision it was bound
	// to (Tines/751), so refs like `<project>/<number>` resolve; other runs list none.
	const memberRun = actor.runRestriction
		? runProjectActor(actor, actor.runRestriction.projectId)?.member
		: undefined;
	if (actor.agentRunId && !memberRun) return [];
	let query = db
		.selectFrom('project as p')
		.innerJoin('project_member as m', 'm.project_id', 'p.id')
		.innerJoin('user as owner', 'owner.id', 'p.user_id')
		.select([
			'p.id',
			'p.name',
			'p.description',
			'p.created_at',
			'p.updated_at',
			'p.archived_at',
			'p.shared_at',
			'p.sharing_revision',
			'p.default_workflow_id',
			'm.revision as membership_revision',
			'owner.id as owner_id',
			'owner.name as owner_name'
		])
		.select((eb) =>
			eb
				.selectFrom('issue')
				.select((b) => b.fn.countAll<number>().as('n'))
				.whereRef('issue.project_id', '=', 'p.id')
				.as('issue_count')
		)
		.where('m.user_id', '=', actor.userId)
		.where('m.revoked_at', 'is', null)
		.where('p.shared_at', 'is not', null)
		.where(projectReadPredicate(actor, 'p.id'))
		.orderBy('p.created_at');
	if (archived === 'false') query = query.where('p.archived_at', 'is', null);
	if (archived === 'true') query = query.where('p.archived_at', 'is not', null);
	if (memberRun)
		query = query
			.where('p.id', '=', memberRun.projectId)
			.where('m.revision', '=', memberRun.membershipRevision);
	const rows = await query.execute();
	const current = await db
		.selectFrom('project_member')
		.select(['project_id', 'revision'])
		.where('user_id', '=', actor.userId)
		.where('revoked_at', 'is', null)
		.execute();
	const revisions = new Map(current.map((row) => [row.project_id, row.revision]));
	if (rows.some((row) => revisions.get(row.id) !== row.membership_revision)) throw notFound();
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		description: row.description,
		default_workflow_id: row.default_workflow_id,
		owner: { id: row.owner_id, name: row.owner_name },
		viewer_role: 'member' as const,
		archived_at: row.archived_at,
		shared_at: row.shared_at,
		sharing_revision: row.sharing_revision,
		created_at: row.created_at,
		updated_at: row.updated_at,
		issue_count: Number(row.issue_count),
		capabilities: { read: true, invite: false, create_issue: true, leave: true }
	}));
}

export const visibleProjectPredicate = (
	userId: string
) => sql<boolean>`(project.user_id = ${userId} OR
	(project.shared_at IS NOT NULL AND EXISTS (SELECT 1 FROM project_member m WHERE m.project_id = project.id
	AND m.user_id = ${userId} AND m.revoked_at IS NULL)))`;
