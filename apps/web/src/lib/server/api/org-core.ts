/**
 * Organizations: the identifiers and SQL expressions every other module
 * shares (docs/organizations.md).
 *
 * Every user has a personal organization `org_<user id>`. A NULL
 * `organization_id` on a project, workflow, context item or label means its
 * owner's personal organization, so a row written without one (by code that
 * predates organizations) stays where it always was.
 */
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Database } from '$lib/server/db';

export function personalOrgId(userId: string): string {
	return `org_${userId}`;
}

/** `COALESCE(<alias>.organization_id, 'org_' || <alias>.user_id)` for a row that has both. */
export function orgOf(alias: string): RawBuilder<string> {
	return sql<string>`COALESCE(${sql.ref(`${alias}.organization_id`)}, 'org_' || ${sql.ref(`${alias}.user_id`)})`;
}

/** The organization a project belongs to, as a scalar subquery. */
export function projectOrgExpr(projectId: string | RawBuilder<string>): RawBuilder<string> {
	return sql<string>`(SELECT COALESCE(p.organization_id, 'org_' || p.user_id) FROM project p WHERE p.id = ${projectId})`;
}

/** Creates the user's personal organization if it is missing (accounts made before or during the migration). */
export async function ensurePersonalOrganization(
	db: Kysely<Database>,
	user: { id: string; name?: string | null; email?: string | null }
): Promise<string> {
	const id = personalOrgId(user.id);
	const now = Date.now();
	await db
		.insertInto('organization')
		.values({
			id,
			name: user.name || user.email || 'Personal',
			kind: 'personal',
			owner_user_id: user.id,
			created_by: user.id,
			created_at: now,
			updated_at: now
		})
		.onConflict((oc) => oc.doNothing())
		.execute();
	await db
		.insertInto('organization_member')
		.values({
			organization_id: id,
			user_id: user.id,
			role: 'owner',
			joined_at: now,
			revoked_at: null,
			updated_at: now
		})
		.onConflict((oc) => oc.doNothing())
		.execute();
	return id;
}

/** The project's organization: id, kind and owner (a missing personal row reads as personal). */
export async function projectOrganization(
	db: Kysely<Database>,
	projectId: string
): Promise<{
	id: string;
	kind: 'personal' | 'shared';
	owner_user_id: string;
	name: string;
} | null> {
	const row = await db
		.selectFrom('project')
		.leftJoin('organization', (join) =>
			join.on(
				sql`organization.id`,
				'=',
				sql`COALESCE(project.organization_id, 'org_' || project.user_id)`
			)
		)
		.select([
			sql<string>`COALESCE(project.organization_id, 'org_' || project.user_id)`.as('org_id'),
			'organization.kind',
			'organization.name',
			'project.user_id'
		])
		.where('project.id', '=', projectId)
		.executeTakeFirst();
	if (!row) return null;
	return {
		id: row.org_id,
		kind: row.kind ?? 'personal',
		owner_user_id: row.user_id,
		name: row.name ?? 'Personal'
	};
}

/**
 * Context items that apply in an issue's project: anything anchored to a
 * project or an issue (the other clauses place those), and a project-less
 * item only when it belongs to the project's organization. This is what
 * keeps an owner's personal global items out of a shared organization.
 */
export function contextOrgPredicate(projectId: string, table = 'context_item') {
	const t = sql.raw(table);
	return sql<boolean>`(${t}.project_id IS NOT NULL OR ${t}.issue_id IS NOT NULL
		OR COALESCE(${t}.organization_id, 'org_' || ${t}.user_id) = ${projectOrgExpr(projectId)})`;
}
