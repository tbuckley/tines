import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { ApiFail, notFound, type ActorContext } from './core';
import { accessAllowed, requireAccess } from './permissions';
import type { QueryGuard } from './query-guard';

export type ProjectAccess = {
	projectId: string;
	ownerId: string;
	role: 'owner' | 'member';
	sharingRevision: number;
	membershipRevision: number | null;
	archivedAt: number | null;
};

/** The project and viewer-membership columns an access decision reads. */
export type ProjectAccessRow = {
	user_id: string;
	shared_at: number | null;
	sharing_revision: number;
	archived_at: number | null;
	revision: number | null;
	revoked_at: number | null;
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
	return projectAccessFromRow(actor, projectId, row);
}

/**
 * The decision `resolveProjectAccess` makes, over a row the caller already
 * read — so a page can fold the access columns into a query it makes anyway
 * instead of paying a round trip of its own. The row must be read in the
 * same request: a cached row is never authority.
 */
export function projectAccessFromRow(
	actor: ActorContext,
	projectId: string,
	row: ProjectAccessRow | undefined
): ProjectAccess {
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
	// A run key is never a human membership credential: a member-contributor
	// run is a member only of the project it was admitted to, at the revision
	// it was admitted under.
	const binding = actor.runRestriction?.binding;
	if (
		(actor.agentRunId &&
			(actor.runRestriction?.projectId !== projectId ||
				!binding ||
				binding.membershipRevision === null ||
				binding.membershipRevision !== row.revision)) ||
		row.shared_at === null ||
		row.revision == null ||
		row.revoked_at !== null
	)
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

/**
 * A run key's write still needs its binding at commit (Tines/751): the run is
 * live and not cancel-requested, its key is unrevoked and unexpired, the run's
 * issue is still in the bound project under the bound assignment token, and
 * the contributor still owns the project or is a current member at the bound
 * revision. Evaluated in the same D1 batch as the write. True for non-run actors.
 */
export function runStillBoundPredicate(actor: ActorContext) {
	const restriction = actor.runRestriction;
	if (!restriction) return sql<boolean>`1`;
	const binding = restriction.binding;
	if (!actor.apiKeyId) return sql<boolean>`0`;
	// `requireActor` always binds a run key; an actor built without one (older
	// test fixtures) still gets the liveness, key and project checks.
	const authority = binding
		? sql<boolean>`r.user_id = ${binding.contributorUserId}
			AND (r.admitted_project_id IS NULL OR i.project_assignment_token = ${binding.assignmentToken})
			AND (p.user_id = ${binding.contributorUserId} OR (p.shared_at IS NOT NULL
				AND m.revoked_at IS NULL AND m.revision = ${binding.membershipRevision}))`
		: sql<boolean>`1`;
	return sql<boolean>`EXISTS (SELECT 1 FROM agent_run r
		JOIN api_key k ON k.id = r.api_key_id
		JOIN issue i ON i.id = r.issue_id
		JOIN project p ON p.id = i.project_id
		LEFT JOIN project_member m ON m.project_id = p.id AND m.user_id = r.user_id
		WHERE r.id = ${restriction.runId} AND r.status IN ('launching','running')
			AND r.cancel_requested_at IS NULL
			AND k.id = ${actor.apiKeyId} AND k.revoked_at IS NULL
			AND (k.expires_at IS NULL OR k.expires_at > ${Date.now()})
			AND i.project_id = ${restriction.projectId} AND ${authority})`;
}

/** `runStillBoundPredicate` as a batch guard; undefined for non-run actors, whose writes stay unguarded. */
export function runBoundGuard(actor: ActorContext): QueryGuard | undefined {
	return actor.runRestriction ? { predicate: runStillBoundPredicate(actor) } : undefined;
}

/** Throws 401 `run_key_inactive` when a run key's binding lapsed before its write committed. */
export async function assertRunStillBound(
	db: Kysely<Database>,
	actor: ActorContext
): Promise<void> {
	if (!actor.runRestriction) return;
	const row = await sql<{
		bound: number;
	}>`SELECT ${runStillBoundPredicate(actor)} AS bound`.execute(db);
	if (!row.rows[0]?.bound)
		throw new ApiFail(401, 'run_key_inactive', 'This run key is no longer active');
}

/** A write uses the revision seen at preflight, so removal/rejoin cannot reuse access. */
export function currentProjectWriterPredicate(
	projectId: string,
	actor: ActorContext,
	access: ProjectAccess,
	issueId?: string
) {
	const run = runStillBoundPredicate(actor);
	return access.role === 'owner'
		? sql<boolean>`${run} AND EXISTS (SELECT 1 FROM project WHERE id = ${projectId} AND user_id = ${actor.userId}
			AND (archived_at IS NULL OR ${
				issueId && actor.agentRunId
					? sql<boolean>`EXISTS (SELECT 1 FROM agent_run WHERE id = ${actor.agentRunId}
					AND issue_id = ${issueId} AND status IN ('assigned','launching','running'))`
					: sql<boolean>`0`
			}))`
		: sql<boolean>`${run} AND EXISTS (SELECT 1 FROM project_member m JOIN project p ON p.id = m.project_id
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
			(!actor.agentRunId ||
				row.owner_id === actor.userId ||
				row.id === actor.runRestriction?.projectId) &&
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
	if (actor.agentRunId) return runProjectActor(actor, projectId) ?? actor;
	const owned = await db
		.selectFrom('project')
		.select('user_id')
		.where('id', '=', projectId)
		.executeTakeFirst();
	// Unknown projects and the actor's own fall through to the owner services,
	// which keep their existing 404s and messages.
	if (!owned || owned.user_id === actor.userId) return actor;
	const access = await resolveProjectAccess(db, actor, projectId);
	if (access.role === 'owner') return actor;
	const owner = await db
		.selectFrom('user')
		.select('name')
		.where('id', '=', access.ownerId)
		.executeTakeFirstOrThrow();
	return memberActor(actor, access, owner.name);
}

/**
 * A member-contributor run's delegated actor for its admitted project, or
 * null (the caller keeps the run's own actor) for any other project, for a
 * run the contributor's own project, and for non-run actors. Built from the
 * immutable binding read at authentication — never a fresh membership read —
 * so a removal and rejoin cannot revive the run. The key, run, runner and
 * attribution stay the contributor's; only owner-scoped loaders see the
 * owner's `userId`, and `member` makes every `assertNotMember` fence apply.
 */
export function runProjectActor(actor: ActorContext, projectId: string): ActorContext | null {
	const restriction = actor.runRestriction;
	const binding = restriction?.binding;
	if (
		actor.member ||
		!restriction ||
		!binding ||
		restriction.projectId !== projectId ||
		binding.projectOwnerId === binding.contributorUserId ||
		binding.membershipRevision === null
	)
		return null;
	return {
		...actor,
		userId: binding.projectOwnerId,
		userName: binding.projectOwnerName,
		member: {
			userId: binding.contributorUserId,
			userName: binding.contributorName,
			projectId,
			membershipRevision: binding.membershipRevision
		}
	};
}

/** `actorForProject`'s member branch, for a caller that already holds the access and owner name. */
export function memberActor(
	actor: ActorContext,
	access: ProjectAccess,
	ownerName: string
): ActorContext {
	if (access.role === 'owner') return actor;
	return {
		...actor,
		userId: access.ownerId,
		userName: ownerName,
		member: {
			userId: actor.userId,
			userName: actor.userName,
			projectId: access.projectId,
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
	const run = runStillBoundPredicate(actor);
	return actor.member
		? sql<boolean>`${run} AND ${currentMemberPredicate(
				actor.member.projectId,
				actor.member.userId,
				actor.member.membershipRevision
			)}`
		: run;
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
