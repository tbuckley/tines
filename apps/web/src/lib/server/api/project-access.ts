import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { ApiFail, notFound, type ActorContext } from './core';
import { accessAllowed, requireAccess } from './permissions';

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
	requireAccess(actor, [{ domain: 'project', access: 'read', projectId }], 'project.read', {
		projectId
	});
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
	// Members work on everything in the project; only people management is the owner's.
	if (operation === 'read' || operation === 'people' || operation === 'write') return;
	if (operation === 'leave' && access.role === 'member') return;
	if (access.role !== 'owner')
		throw new ApiFail(
			403,
			'member_read_only',
			'Only the project owner can invite or remove people.'
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
	const visible = rows.filter(
		(row) =>
			(!actor.agentRunId || row.owner_id === actor.userId) &&
			accessAllowed(
				actor,
				[{ domain: 'project', access: 'read', projectId: row.id }],
				'project.read',
				{ projectId: row.id }
			)
	);
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

/**
 * The actor to run a project-scoped operation as. The owner acts as
 * themselves. A current member acts with the owner's scope — so the owner's
 * project, issue, schedule and artifact services resolve the shared project —
 * while `member` keeps who actually acted for attribution, personal
 * permission and the membership check at write time. Routes that reach
 * account-level resources (runners, routing, the workflow library, global
 * context) must not call this.
 */
export async function actorForProject(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string
): Promise<ActorContext> {
	if (actor.member) return actor;
	const owned = await db
		.selectFrom('project')
		.select('user_id')
		.where('id', '=', projectId)
		.executeTakeFirst();
	// Unknown projects and the actor's own fall through to the owner services,
	// which keep their existing 404s and messages.
	if (!owned || owned.user_id === actor.userId || actor.agentRunId) return actor;
	const access = await resolveProjectAccess(db, actor, projectId);
	if (access.role === 'owner') return actor;
	const owner = await db
		.selectFrom('user')
		.select('name')
		.where('id', '=', access.ownerId)
		.executeTakeFirstOrThrow();
	return {
		...actor,
		userId: access.ownerId,
		userName: owner.name,
		member: {
			userId: actor.userId,
			userName: actor.userName,
			projectId,
			membershipRevision: access.membershipRevision!
		}
	};
}

export async function actorForIssue(
	db: Kysely<Database>,
	actor: ActorContext,
	issueId: string
): Promise<ActorContext> {
	const row = await db
		.selectFrom('issue')
		.select('project_id')
		.where('id', '=', issueId)
		.executeTakeFirst();
	return row ? actorForProject(db, actor, row.project_id) : actor;
}

export async function actorForSchedule(
	db: Kysely<Database>,
	actor: ActorContext,
	scheduleId: string
): Promise<ActorContext> {
	const row = await db
		.selectFrom('scheduled_task')
		.select('project_id')
		.where('id', '=', scheduleId)
		.executeTakeFirst();
	return row ? actorForProject(db, actor, row.project_id) : actor;
}

/** The member acting as themselves again, for checks on their own access. */
export function memberSelf(actor: ActorContext): ActorContext {
	if (!actor.member) return actor;
	return { ...actor, userId: actor.member.userId, userName: actor.member.userName, member: null };
}

/**
 * A member's write still needs their membership at commit: removal between
 * preflight and the write must not let it land. True for everyone else.
 */
export function memberStillCurrentPredicate(actor: ActorContext) {
	return actor.member
		? currentMemberPredicate(
				actor.member.projectId,
				actor.member.userId,
				actor.member.membershipRevision
			)
		: sql<boolean>`1`;
}

/** Throws 404 when a delegated member was removed since their request began. */
export async function assertMemberStillCurrent(
	db: Kysely<Database>,
	actor: ActorContext
): Promise<void> {
	if (!actor.member) return;
	const row = await db
		.selectFrom('project_member as m')
		.innerJoin('project as p', 'p.id', 'm.project_id')
		.select('m.revision')
		.where('m.project_id', '=', actor.member.projectId)
		.where('m.user_id', '=', actor.member.userId)
		.where('m.revoked_at', 'is', null)
		.where('p.shared_at', 'is not', null)
		.executeTakeFirst();
	if (row?.revision !== actor.member.membershipRevision) throw notFound();
}

/** Refuses a delegated member an account-level action that stays the owner's. */
export function assertNotMember(actor: Pick<ActorContext, 'member'>, what: string): void {
	if (actor.member) throw new ApiFail(403, 'owner_only', `${what} belongs to the project owner.`);
}
