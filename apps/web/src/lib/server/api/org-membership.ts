/**
 * Organization membership, projected onto projects (docs/organizations.md).
 *
 * A shared organization's projects are owned by its owner, and everyone else
 * in it is a member of each of its projects. Rather than teach every member
 * check, consent rule and run-key fence about organizations, joining or
 * leaving an organization (and moving a project into or out of one) writes
 * the matching `project_member` rows: the project-level sharing machinery
 * (Tines/669–752) then applies unchanged. `project_member` is no longer
 * edited by hand for a project in a shared organization.
 */
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';

/**
 * The first-sharing conversion, exactly as the first project invitation makes
 * it (invitations.ts): the project enters consent mode. A no-op for a
 * project already shared. `guard` must hold for anything to change.
 */
export function firstShareQueries(
	db: Kysely<Database>,
	projectId: string,
	actor: { userId: string; apiKeyId: string | null },
	now: number,
	guard = sql<boolean>`1`
): CompiledQuery[] {
	const unshared = sql<boolean>`EXISTS (SELECT 1 FROM project WHERE id = ${projectId} AND shared_at IS NULL)`;
	const releaseToken = newId('rel');
	return [
		sql`UPDATE issue_personal_choice SET value = 'unset', revision = revision + 1, updated_at = ${now}
			WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId}) AND ${unshared} AND ${guard}`.compile(
			db
		),
		sql`UPDATE schedule_personal_choice SET value = 'off', revision = revision + 1, updated_at = ${now}
			WHERE schedule_id IN (SELECT id FROM scheduled_task WHERE project_id = ${projectId}) AND ${unshared} AND ${guard}`.compile(
			db
		),
		sql`UPDATE agent_run SET status = 'canceled', outcome = NULL, ended_at = ${now},
			error = 'First sharing requires fresh personal permission', assignment_release_token = ${releaseToken}
			WHERE status = 'assigned' AND issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})
			AND ${unshared} AND ${guard}`.compile(db),
		sql`UPDATE api_key SET revoked_at = ${now} WHERE revoked_at IS NULL AND agent_run_id IN
			(SELECT id FROM agent_run WHERE assignment_release_token = ${releaseToken})`.compile(db),
		sql`INSERT INTO event (id,user_id,type,actor_user_id,actor_api_key_id,project_id,payload,created_at)
			SELECT ${newId('evt')}, p.user_id, 'project.sharing_started', ${actor.userId}, ${actor.apiKeyId},
			${projectId}, '{}', ${now} FROM project p WHERE p.id = ${projectId} AND p.shared_at IS NULL AND ${guard}`.compile(
			db
		),
		sql`UPDATE project SET shared_at = ${now}, sharing_revision = sharing_revision + 1, updated_at = ${now}
			WHERE id = ${projectId} AND shared_at IS NULL AND ${guard}`.compile(db)
	];
}

/** Makes `userId` a current member of the project (a new revision if they had left). */
export function grantProjectMemberQueries(
	db: Kysely<Database>,
	projectId: string,
	userId: string,
	actor: { userId: string; apiKeyId: string | null },
	now: number,
	guard = sql<boolean>`1`
): CompiledQuery[] {
	return [
		sql`INSERT INTO project_member (project_id, user_id, revision, joined_at, revoked_at, updated_at)
			SELECT ${projectId}, ${userId}, 1, ${now}, NULL, ${now}
			WHERE ${guard} AND NOT EXISTS (SELECT 1 FROM project WHERE id = ${projectId} AND user_id = ${userId})
			ON CONFLICT(project_id, user_id) DO UPDATE SET revision = project_member.revision + 1,
				joined_at = excluded.joined_at, revoked_at = NULL, updated_at = excluded.updated_at
			WHERE project_member.revoked_at IS NOT NULL`.compile(db),
		sql`INSERT INTO event (id,user_id,type,actor_user_id,actor_api_key_id,project_id,payload,created_at)
			SELECT ${newId('evt')}, p.user_id, 'project.member_joined', ${actor.userId}, ${actor.apiKeyId}, ${projectId},
			json_object('member_user_id', ${userId}, 'membership_revision', m.revision, 'via', 'organization'), ${now}
			FROM project p JOIN project_member m ON m.project_id = p.id AND m.user_id = ${userId}
			WHERE p.id = ${projectId} AND m.joined_at = ${now} AND m.revoked_at IS NULL AND ${guard}`.compile(
			db
		)
	];
}

/**
 * Ends `userId`'s membership of the project, exactly as removing a member
 * does (invitations.ts `removeMember`): their personal choices there end,
 * assigned runs are released and running ones asked to cancel, with their keys.
 */
export function revokeProjectMemberQueries(
	db: Kysely<Database>,
	projectId: string,
	userId: string,
	actor: { userId: string; apiKeyId: string | null },
	now: number,
	reason: string,
	guard = sql<boolean>`1`
): CompiledQuery[] {
	const cancelToken = newId('cancel');
	const requestToken = newId('mem');
	const revoked = sql<boolean>`EXISTS (SELECT 1 FROM project_member WHERE project_id = ${projectId}
		AND user_id = ${userId} AND last_request_token = ${requestToken})`;
	return [
		sql`UPDATE project_member SET revision = revision + 1, revoked_at = ${now}, updated_at = ${now},
			last_request_token = ${requestToken}
			WHERE project_id = ${projectId} AND user_id = ${userId} AND revoked_at IS NULL AND ${guard}`.compile(
			db
		),
		sql`UPDATE issue_personal_choice SET value = 'unset', revision = revision + 1, updated_at = ${now}
			WHERE user_id = ${userId} AND issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId}) AND ${revoked}`.compile(
			db
		),
		sql`UPDATE schedule_personal_choice SET value = 'off', revision = revision + 1, updated_at = ${now}
			WHERE user_id = ${userId} AND schedule_id IN (SELECT id FROM scheduled_task WHERE project_id = ${projectId})
			AND ${revoked}`.compile(db),
		sql`UPDATE agent_run SET status = 'canceled', ended_at = ${now}, assignment_release_token = ${cancelToken}
			WHERE user_id = ${userId} AND status = 'assigned' AND issue_id IN
			(SELECT id FROM issue WHERE project_id = ${projectId}) AND ${revoked}`.compile(db),
		sql`UPDATE agent_run SET cancel_requested_at = ${now}, cancel_requested_by_user_id = ${actor.userId},
			cancel_reason = ${reason}, cancellation_token = ${cancelToken}
			WHERE user_id = ${userId} AND status IN ('launching','running') AND cancel_requested_at IS NULL
			AND issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId}) AND ${revoked}`.compile(db),
		sql`UPDATE api_key SET revoked_at = ${now} WHERE agent_run_id IN (SELECT id FROM agent_run
			WHERE user_id = ${userId} AND issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})
			AND (assignment_release_token = ${cancelToken} OR cancellation_token = ${cancelToken}))
			AND revoked_at IS NULL`.compile(db),
		sql`INSERT INTO event (id,user_id,type,actor_user_id,actor_api_key_id,project_id,payload,created_at)
			SELECT ${newId('evt')}, p.user_id, 'project.member_removed', ${actor.userId}, ${actor.apiKeyId}, ${projectId},
			json_object('member_user_id', ${userId}, 'via', 'organization'), ${now}
			FROM project p WHERE p.id = ${projectId} AND ${revoked}`.compile(db)
	];
}

/** Current members of a shared organization other than its owner. */
export async function orgMemberIds(
	db: Kysely<Database>,
	orgId: string,
	exceptUserId?: string
): Promise<string[]> {
	const rows = await db
		.selectFrom('organization_member')
		.select('user_id')
		.where('organization_id', '=', orgId)
		.where('revoked_at', 'is', null)
		.execute();
	return rows.map((r) => r.user_id).filter((id) => id !== exceptUserId);
}

/** Projects of an organization (by its id; a personal one includes legacy NULL rows). */
export async function orgProjectIds(db: Kysely<Database>, orgId: string): Promise<string[]> {
	const rows = await db
		.selectFrom('project')
		.select('id')
		.where(sql<boolean>`COALESCE(organization_id, 'org_' || user_id) = ${orgId}`)
		.execute();
	return rows.map((r) => r.id);
}
