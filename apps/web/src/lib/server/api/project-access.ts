import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { ApiFail, notFound, type ActorContext } from './core';

export type ProjectAccess = {
	projectId: string;
	ownerId: string;
	role: 'owner' | 'member';
	sharingRevision: number;
	membershipRevision: number | null;
	archivedAt: number | null;
};

/** Membership is checked against D1 on every request, never a cookie claim. */
export async function resolveProjectAccess(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string
): Promise<ProjectAccess> {
	const row = await db
		.selectFrom('project as p')
		.leftJoin('project_member as m', (join) =>
			join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', actor.userId)
		)
		.select([
			'p.id',
			'p.user_id',
			'p.shared_at',
			'p.sharing_revision',
			'p.archived_at',
			'm.revision',
			'm.revoked_at'
		])
		.where('p.id', '=', projectId)
		.executeTakeFirst();
	if (!row) throw notFound();
	if (row.user_id === actor.userId)
		return {
			projectId,
			ownerId: row.user_id,
			role: 'owner',
			sharingRevision: row.sharing_revision,
			membershipRevision: null,
			archivedAt: row.archived_at
		};
	// A run key is never a human membership credential.
	if (actor.agentRunId || row.shared_at === null || row.revision == null || row.revoked_at !== null)
		throw notFound();
	return {
		projectId,
		ownerId: row.user_id,
		role: 'member',
		sharingRevision: row.sharing_revision,
		membershipRevision: row.revision,
		archivedAt: row.archived_at
	};
}

export async function resolveIssueAccess(
	db: Kysely<Database>,
	actor: ActorContext,
	issueId: string
): Promise<ProjectAccess> {
	const row = await db
		.selectFrom('issue')
		.select('project_id')
		.where('id', '=', issueId)
		.executeTakeFirst();
	if (!row) throw notFound();
	return resolveProjectAccess(db, actor, row.project_id);
}

export function assertCapability(
	access: ProjectAccess,
	operation: 'read' | 'people' | 'write' | 'invite' | 'leave'
): void {
	if (operation === 'read' || operation === 'people') return;
	if (operation === 'leave' && access.role === 'member') return;
	if (access.role !== 'owner')
		throw new ApiFail(
			403,
			'member_read_only',
			'Members can read this project; this action is available to its owner.'
		);
}

/** Reuse in member write CASes; a cached access result alone is never authority. */
export function currentMemberPredicate(projectId: string, userId: string, revision: number) {
	return sql<boolean>`EXISTS (SELECT 1 FROM project_member m JOIN project p ON p.id = m.project_id
		WHERE m.project_id = ${projectId} AND m.user_id = ${userId} AND m.revision = ${revision}
		AND m.revoked_at IS NULL AND p.shared_at IS NOT NULL)`;
}

/** A write uses the revision seen at preflight, so removal/rejoin cannot reuse access. */
export function currentProjectWriterPredicate(
	projectId: string,
	actor: ActorContext,
	access: ProjectAccess,
	issueId?: string
) {
	return access.role === 'owner'
		? sql<boolean>`EXISTS (SELECT 1 FROM project WHERE id = ${projectId} AND user_id = ${actor.userId}
			AND (archived_at IS NULL OR ${
				issueId && actor.agentRunId
					? sql<boolean>`EXISTS (SELECT 1 FROM agent_run WHERE id = ${actor.agentRunId}
					AND issue_id = ${issueId} AND status IN ('assigned','launching','running'))`
					: sql<boolean>`0`
			}))`
		: sql<boolean>`EXISTS (SELECT 1 FROM project_member m JOIN project p ON p.id = m.project_id
			WHERE m.project_id = ${projectId} AND m.user_id = ${actor.userId}
			AND m.revision = ${access.membershipRevision} AND m.revoked_at IS NULL
			AND p.shared_at IS NOT NULL AND p.archived_at IS NULL)`;
}

/** Immutable IDs win. Legacy names resolve only within the viewer's accessible set. */
export async function resolveAccessibleProjectRef(
	db: Kysely<Database>,
	actor: ActorContext,
	ref: string
): Promise<string> {
	const byId = await db.selectFrom('project').select('id').where('id', '=', ref).executeTakeFirst();
	if (byId) {
		await resolveProjectAccess(db, actor, byId.id);
		return byId.id;
	}
	const rows = await db
		.selectFrom('project as p')
		.leftJoin('project_member as m', (join) =>
			join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', actor.userId)
		)
		.innerJoin('user as owner', 'owner.id', 'p.user_id')
		.select(['p.id', 'p.name', 'owner.id as owner_id', 'owner.name as owner_name'])
		.where('p.name', '=', ref)
		.where((eb) =>
			eb.or([
				eb('p.user_id', '=', actor.userId),
				eb.and([
					eb('p.shared_at', 'is not', null),
					eb('m.revoked_at', 'is', null),
					eb('m.revision', 'is not', null)
				])
			])
		)
		.execute();
	const visible = actor.agentRunId ? rows.filter((row) => row.owner_id === actor.userId) : rows;
	if (!visible.length) throw notFound();
	if (visible.length > 1)
		throw new ApiFail(
			409,
			'ambiguous_project',
			'More than one accessible project has this name; use its immutable ID',
			{
				choices: visible.map((row) => ({
					id: row.id,
					name: row.name,
					owner: { id: row.owner_id, name: row.owner_name }
				}))
			}
		);
	return visible[0].id;
}
