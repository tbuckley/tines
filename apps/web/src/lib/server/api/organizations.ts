/**
 * Organizations (specs/packs/ORGANIZATIONS_SPEC.md, docs/organizations.md):
 * the unit of sharing. Every user has a personal organization; a shared one
 * has an owner and managers, and everyone in it can work in every project in
 * it. A shared organization's projects, workflows, labels and context are
 * owned (`user_id`) by its owner, and its other people are members of each of
 * its projects (`org-membership.ts`), so the project-level sharing rules —
 * consent, run binding, the member read boundary — apply unchanged.
 */
import type { OrganizationDetail, OrganizationRole, OrganizationSummary } from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { sha256Hex } from '../crypto';
import {
	ApiFail,
	attributedUserId,
	notFound,
	requireString,
	runAtomic,
	type ActorContext
} from './core';
import { recordIsolatedInvitation, sendInvitationEmail } from './invitation-email';
import { ensurePersonalOrganization, personalOrgId } from './org-core';
import {
	firstShareQueries,
	grantProjectMemberQueries,
	orgMemberIds,
	orgProjectIds,
	revokeProjectMemberQueries
} from './org-membership';

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** The person acting (not a delegated owner scope). */
export function personOf(actor: ActorContext): string {
	return attributedUserId(actor);
}

/** API keys reach only the organizations their policy names (docs/organizations.md, "API keys"). */
export function keyReachesOrg(actor: ActorContext, orgId: string): boolean {
	const scope = actor.organizationScope;
	return !scope || scope === 'all' || scope.includes(orgId);
}

function noRunKey(actor: ActorContext) {
	if (actor.agentRunId)
		throw new ApiFail(403, 'run_key_forbidden', 'Run keys cannot manage organizations');
}

function browserOnly(actor: ActorContext, what: string) {
	if (!actor.viaSession || actor.bearerPresent || actor.apiKeyId)
		throw new ApiFail(403, 'session_required', `${what} needs your browser session`);
}

export interface OrgAccess {
	org: {
		id: string;
		name: string;
		kind: 'personal' | 'shared';
		owner_user_id: string;
		revision: number;
	};
	role: OrganizationRole;
	revision: number;
}

/** The person's current membership of an organization, or 404. */
export async function requireOrg(
	db: Kysely<Database>,
	actor: ActorContext,
	orgId: string,
	roles: OrganizationRole[] = ['owner', 'manager', 'member']
): Promise<OrgAccess> {
	const person = personOf(actor);
	if (orgId === personalOrgId(person))
		await ensurePersonalOrganization(db, { id: person, name: actor.userName });
	const row = await db
		.selectFrom('organization as o')
		.innerJoin('organization_member as m', (join) =>
			join.onRef('m.organization_id', '=', 'o.id').on('m.user_id', '=', person)
		)
		.select([
			'o.id',
			'o.name',
			'o.kind',
			'o.owner_user_id',
			'o.revision',
			'm.role',
			'm.revision as member_revision'
		])
		.where('o.id', '=', orgId)
		.where('m.revoked_at', 'is', null)
		.executeTakeFirst();
	if (!row || !keyReachesOrg(actor, orgId)) throw notFound();
	if (!roles.includes(row.role))
		throw new ApiFail(
			403,
			'organization_role',
			row.role === 'manager'
				? 'Only the organization owner can do this'
				: 'You cannot change this organization'
		);
	return {
		org: {
			id: row.id,
			name: row.name,
			kind: row.kind,
			owner_user_id: row.owner_user_id,
			revision: row.revision
		},
		role: row.role,
		revision: row.member_revision
	};
}

// ---------------------------------------------------------------------------
// Reads

export async function listOrganizations(
	db: Kysely<Database>,
	actor: ActorContext
): Promise<OrganizationSummary[]> {
	const person = personOf(actor);
	const personalId = personalOrgId(person);
	// One wave of reads (page loads budget it): an account made after
	// migration 0053 has no personal row until something writes to it
	// (`requireOrg`), so it is synthesized here rather than inserted on a read.
	const [user, personalProjects, rows] = await Promise.all([
		db.selectFrom('user').select(['name', 'email']).where('id', '=', person).executeTakeFirst(),
		db
			.selectFrom('project')
			.where('user_id', '=', person)
			.where(sql<boolean>`COALESCE(organization_id, 'org_' || user_id) = ${personalId}`)
			.select((eb) => eb.fn.countAll<number>().as('n'))
			.executeTakeFirst(),
		db
			.selectFrom('organization as o')
			.innerJoin('organization_member as m', (join) =>
				join.onRef('m.organization_id', '=', 'o.id').on('m.user_id', '=', person)
			)
			.leftJoin('user as owner', 'owner.id', 'o.owner_user_id')
			.select([
				'o.id',
				'o.name',
				'o.kind',
				'o.revision',
				'o.created_at',
				'o.owner_user_id',
				'owner.name as owner_name',
				'm.role',
				(eb) =>
					eb
						.selectFrom('organization_member as mm')
						.whereRef('mm.organization_id', '=', 'o.id')
						.where('mm.revoked_at', 'is', null)
						.select((eb2) => eb2.fn.countAll<number>().as('n'))
						.as('member_count'),
				(eb) =>
					eb
						.selectFrom('project as p')
						.where(sql<boolean>`COALESCE(p.organization_id, 'org_' || p.user_id) = o.id`)
						.select((eb2) => eb2.fn.countAll<number>().as('n'))
						.as('project_count')
			])
			.where('m.revoked_at', 'is', null)
			.orderBy(sql`o.kind = 'shared'`)
			.orderBy('o.name')
			.execute()
	]);
	const all = rows.some((r) => r.id === personalId)
		? rows
		: [
				{
					id: personalId,
					name: user?.name || user?.email || 'Personal',
					kind: 'personal' as const,
					revision: 0,
					created_at: Date.now(),
					owner_user_id: person,
					owner_name: user?.name ?? null,
					role: 'owner' as const,
					member_count: 1,
					project_count: Number(personalProjects?.n ?? 0)
				},
				...rows
			];
	return all
		.filter((r) => keyReachesOrg(actor, r.id))
		.map((r) => ({
			id: r.id,
			name: r.name,
			kind: r.kind,
			role: r.role,
			owner: { id: r.owner_user_id, name: r.owner_name ?? '' },
			member_count: Number(r.member_count ?? 0),
			project_count: Number(r.project_count ?? 0),
			revision: r.revision,
			created_at: r.created_at
		}));
}

export async function getOrganization(
	db: Kysely<Database>,
	actor: ActorContext,
	orgId: string
): Promise<OrganizationDetail> {
	const access = await requireOrg(db, actor, orgId);
	const [summary] = (await listOrganizations(db, actor)).filter((o) => o.id === orgId);
	if (!summary) throw notFound();
	const [members, invitations, projects] = await Promise.all([
		db
			.selectFrom('organization_member as m')
			.innerJoin('user as u', 'u.id', 'm.user_id')
			.select(['m.user_id', 'u.name', 'u.email', 'm.role', 'm.joined_at', 'm.revision'])
			.where('m.organization_id', '=', orgId)
			.where('m.revoked_at', 'is', null)
			.orderBy('m.joined_at')
			.execute(),
		access.role === 'member'
			? Promise.resolve([])
			: db
					.selectFrom('organization_invitation')
					.select(['id', 'email', 'expires_at', 'created_at', 'delivery_status'])
					.where('organization_id', '=', orgId)
					.where('accepted_at', 'is', null)
					.where('canceled_at', 'is', null)
					.orderBy('created_at')
					.execute(),
		db
			.selectFrom('project as p')
			.select([
				'p.id',
				'p.name',
				'p.archived_at',
				(eb) =>
					eb
						.selectFrom('issue')
						.whereRef('issue.project_id', '=', 'p.id')
						.select((eb2) => eb2.fn.countAll<number>().as('n'))
						.as('issue_count')
			])
			.where(sql<boolean>`COALESCE(p.organization_id, 'org_' || p.user_id) = ${orgId}`)
			.orderBy('p.name')
			.execute()
	]);
	return {
		...summary,
		members: members.map((m) => ({
			user_id: m.user_id,
			name: m.name,
			// People in an organization see each other's emails; it is how invitations work.
			email: m.email,
			role: m.role,
			joined_at: m.joined_at,
			revision: m.revision
		})),
		invitations,
		projects: projects.map((p) => ({ ...p, issue_count: Number(p.issue_count ?? 0) }))
	};
}

// ---------------------------------------------------------------------------
// Create, rename

export async function createOrganization(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	body: { name?: unknown }
): Promise<OrganizationDetail> {
	noRunKey(actor);
	if (actor.organizationScope && actor.organizationScope !== 'all')
		throw new ApiFail(
			403,
			'insufficient_permissions',
			'Creating an organization needs a key with every organization in scope, or the browser'
		);
	const name = requireString(body.name, 'name', { max: 100 }).trim();
	const person = personOf(actor);
	const id = newId('org');
	const now = Date.now();
	await runAtomic(env, [
		db
			.insertInto('organization')
			.values({
				id,
				name,
				kind: 'shared',
				owner_user_id: person,
				created_by: person,
				created_at: now,
				updated_at: now
			})
			.compile(),
		db
			.insertInto('organization_member')
			.values({
				organization_id: id,
				user_id: person,
				role: 'owner',
				joined_at: now,
				revoked_at: null,
				updated_at: now
			})
			.compile()
	]);
	return getOrganization(db, actor, id);
}

export async function renameOrganization(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	orgId: string,
	body: { name?: unknown; expected_revision?: unknown }
): Promise<OrganizationDetail> {
	noRunKey(actor);
	const access = await requireOrg(db, actor, orgId, ['owner']);
	const name = requireString(body.name, 'name', { max: 100 }).trim();
	const result = await db
		.updateTable('organization')
		.set({ name, revision: access.org.revision + 1, updated_at: Date.now() })
		.where('id', '=', orgId)
		.where(
			'revision',
			'=',
			typeof body.expected_revision === 'number' ? body.expected_revision : access.org.revision
		)
		.executeTakeFirst();
	if (Number(result.numUpdatedRows) === 0)
		throw new ApiFail(
			409,
			'organization_changed',
			'The organization changed; reload and try again'
		);
	return getOrganization(db, actor, orgId);
}

// ---------------------------------------------------------------------------
// Invitations

function randomToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function inviteToOrganization(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	orgId: string,
	body: { email?: unknown },
	origin: string
) {
	noRunKey(actor);
	const access = await requireOrg(db, actor, orgId, ['owner', 'manager']);
	if (access.org.kind !== 'shared')
		throw new ApiFail(
			422,
			'personal_organization',
			'A personal organization cannot be shared; create a shared organization instead'
		);
	const email = requireString(body.email, 'email', { max: 320 }).trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
		throw new ApiFail(422, 'invalid_email', 'Enter an email address', { field: 'email' });
	const member = await db
		.selectFrom('organization_member as m')
		.innerJoin('user as u', 'u.id', 'm.user_id')
		.select('m.user_id')
		.where('m.organization_id', '=', orgId)
		.where('m.revoked_at', 'is', null)
		.where(sql<boolean>`lower(u.email) = ${email}`)
		.executeTakeFirst();
	if (member)
		throw new ApiFail(409, 'already_member', 'This person is already in the organization');
	const pending = await db
		.selectFrom('organization_invitation')
		.select('id')
		.where('organization_id', '=', orgId)
		.where('email', '=', email)
		.where('accepted_at', 'is', null)
		.where('canceled_at', 'is', null)
		.executeTakeFirst();
	if (pending)
		throw new ApiFail(409, 'invite_pending', 'An invitation is already pending', {
			invite_id: pending.id
		});
	const now = Date.now();
	const id = newId('oinv');
	const token = randomToken();
	await db
		.insertInto('organization_invitation')
		.values({
			id,
			organization_id: orgId,
			email,
			token_hash: await sha256Hex(token),
			expires_at: now + WEEK,
			created_by_user_id: personOf(actor),
			created_by_api_key_id: actor.apiKeyId,
			created_at: now,
			updated_at: now,
			accepted_by_user_id: null,
			accepted_at: null,
			canceled_at: null
		})
		.execute();
	let status: 'sent' | 'failed' = 'sent';
	try {
		const url = `${origin}/invites/org/${token}`;
		const inviter = await db
			.selectFrom('user')
			.select('name')
			.where('id', '=', personOf(actor))
			.executeTakeFirst();
		await sendInvitationEmail(env, {
			email,
			owner: inviter?.name ?? 'Someone',
			project: `the ${access.org.name} organization`,
			url,
			expiresAt: now + WEEK
		});
		recordIsolatedInvitation(id, url);
	} catch (error) {
		console.error('Organization invitation email failed:', error);
		status = 'failed';
	}
	await db
		.updateTable('organization_invitation')
		.set({ delivery_status: status })
		.where('id', '=', id)
		.execute();
	return { id, email, expires_at: now + WEEK, delivery_status: status };
}

export async function cancelOrganizationInvitation(
	db: Kysely<Database>,
	actor: ActorContext,
	orgId: string,
	inviteId: string
) {
	noRunKey(actor);
	await requireOrg(db, actor, orgId, ['owner', 'manager']);
	const result = await db
		.updateTable('organization_invitation')
		.set({ canceled_at: Date.now(), updated_at: Date.now() })
		.where('id', '=', inviteId)
		.where('organization_id', '=', orgId)
		.where('accepted_at', 'is', null)
		.where('canceled_at', 'is', null)
		.executeTakeFirst();
	if (Number(result.numUpdatedRows) === 0) throw notFound();
	return { id: inviteId, canceled: true };
}

export async function organizationInvitationLanding(
	db: Kysely<Database>,
	token: string,
	viewerId?: string
) {
	if (!/^[a-f0-9]{64}$/.test(token)) throw notFound();
	const row = await db
		.selectFrom('organization_invitation as i')
		.innerJoin('organization as o', 'o.id', 'i.organization_id')
		.leftJoin('user as owner', 'owner.id', 'o.owner_user_id')
		.select([
			'i.email',
			'i.expires_at',
			'i.accepted_at',
			'i.canceled_at',
			'o.id',
			'o.name',
			'owner.name as owner_name'
		])
		.where('i.token_hash', '=', await sha256Hex(token))
		.executeTakeFirst();
	if (!row || row.canceled_at !== null) throw notFound();
	const viewer = viewerId
		? await db
				.selectFrom('user')
				.select(['email', 'emailVerified'])
				.where('id', '=', viewerId)
				.executeTakeFirst()
		: null;
	const matching =
		!!viewer && !!viewer.emailVerified && viewer.email.trim().toLowerCase() === row.email;
	return {
		status:
			row.accepted_at !== null ? 'accepted' : row.expires_at <= Date.now() ? 'expired' : 'pending',
		organization: { id: row.id, name: row.name, owner: row.owner_name ?? '' },
		expires_at: row.expires_at,
		matching_account: matching,
		signed_in: !!viewerId
	};
}

/** Joins the organization as a manager, and every project in it as a member. */
export async function acceptOrganizationInvitation(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	token: string
) {
	browserOnly(actor, 'Accepting an invitation');
	if (!/^[a-f0-9]{64}$/.test(token)) throw notFound();
	const hash = await sha256Hex(token);
	const now = Date.now();
	const invite = await db
		.selectFrom('organization_invitation as i')
		.innerJoin('organization as o', 'o.id', 'i.organization_id')
		.innerJoin('user as u', (join) => join.on('u.id', '=', actor.userId))
		.leftJoin('organization_member as m', (join) =>
			join.onRef('m.organization_id', '=', 'i.organization_id').on('m.user_id', '=', actor.userId)
		)
		.select([
			'i.id',
			'i.organization_id',
			'i.email',
			'i.expires_at',
			'i.accepted_at',
			'i.accepted_by_user_id',
			'i.canceled_at',
			'o.owner_user_id',
			'u.email as user_email',
			'u.emailVerified',
			'm.revision as member_revision',
			'm.revoked_at'
		])
		.where('i.token_hash', '=', hash)
		.executeTakeFirst();
	if (!invite || invite.canceled_at !== null) throw notFound();
	if (!invite.emailVerified || invite.user_email.trim().toLowerCase() !== invite.email)
		throw new ApiFail(
			403,
			'wrong_account',
			'Sign in with the verified email that received this invitation'
		);
	if (invite.accepted_at !== null) {
		if (invite.accepted_by_user_id === actor.userId && invite.revoked_at === null)
			return { organization_id: invite.organization_id, already_accepted: true };
		throw notFound();
	}
	if (invite.expires_at <= now)
		throw new ApiFail(410, 'invite_expired', 'This invitation expired; ask for a new one');
	if (invite.member_revision !== null && invite.revoked_at === null)
		throw new ApiFail(409, 'already_member', 'You are already in this organization');
	const joined = sql<boolean>`EXISTS (SELECT 1 FROM organization_invitation WHERE id = ${invite.id}
		AND accepted_by_user_id = ${actor.userId} AND accepted_at = ${now})`;
	const queries: CompiledQuery[] = [
		sql`UPDATE organization_invitation SET accepted_at = ${now}, accepted_by_user_id = ${actor.userId}, updated_at = ${now}
			WHERE id = ${invite.id} AND token_hash = ${hash} AND accepted_at IS NULL AND canceled_at IS NULL
			AND expires_at > ${now}`.compile(db),
		sql`INSERT INTO organization_member (organization_id, user_id, role, revision, joined_at, revoked_at, updated_at)
			SELECT ${invite.organization_id}, ${actor.userId}, 'manager', 1, ${now}, NULL, ${now} WHERE ${joined}
			ON CONFLICT(organization_id, user_id) DO UPDATE SET role = 'manager', revision = organization_member.revision + 1,
				joined_at = excluded.joined_at, revoked_at = NULL, updated_at = excluded.updated_at
			WHERE organization_member.revoked_at IS NOT NULL`.compile(db)
	];
	for (const projectId of await orgProjectIds(db, invite.organization_id)) {
		queries.push(
			...firstShareQueries(db, projectId, { userId: actor.userId, apiKeyId: null }, now, joined)
		);
		queries.push(
			...grantProjectMemberQueries(
				db,
				projectId,
				actor.userId,
				{ userId: actor.userId, apiKeyId: null },
				now,
				joined
			)
		);
	}
	queries.push(sql`SELECT 1 AS ok WHERE ${joined}`.compile(db));
	const results = await runAtomic(env, queries);
	if (!results.at(-1)?.results?.length)
		throw new ApiFail(409, 'invite_changed', 'Invitation changed; refresh before accepting');
	return { organization_id: invite.organization_id, already_accepted: false };
}

// ---------------------------------------------------------------------------
// People

/** Removes a person (or the caller leaves): their membership of every project in it ends. */
export async function removeOrganizationMember(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	orgId: string,
	userId: string
) {
	noRunKey(actor);
	const self = personOf(actor) === userId;
	const access = await requireOrg(
		db,
		actor,
		orgId,
		self ? ['owner', 'manager', 'member'] : ['owner', 'manager']
	);
	if (access.org.kind !== 'shared')
		throw new ApiFail(422, 'personal_organization', 'A personal organization has no other people');
	if (userId === access.org.owner_user_id)
		throw new ApiFail(
			403,
			'owner_cannot_leave',
			self
				? 'Transfer ownership to a manager first, or delete the organization'
				: 'The owner cannot be removed'
		);
	const now = Date.now();
	const actorRef = { userId: personOf(actor), apiKeyId: actor.apiKeyId };
	const queries: CompiledQuery[] = [
		db
			.updateTable('organization_member')
			.set({ revoked_at: now, revision: sql`revision + 1`, updated_at: now })
			.where('organization_id', '=', orgId)
			.where('user_id', '=', userId)
			.where('revoked_at', 'is', null)
			.compile(),
		sql`UPDATE organization_invitation SET canceled_at = ${now}, updated_at = ${now}
			WHERE organization_id = ${orgId} AND canceled_at IS NULL AND accepted_at IS NULL
			AND email = (SELECT lower(email) FROM user WHERE id = ${userId})`.compile(db)
	];
	for (const projectId of await orgProjectIds(db, orgId))
		queries.push(
			...revokeProjectMemberQueries(
				db,
				projectId,
				userId,
				actorRef,
				now,
				'Organization membership removed'
			)
		);
	await runAtomic(env, queries);
	return { organization_id: orgId, user_id: userId, removed: true };
}

/**
 * Hands the organization to a manager: they become its owner (and the owner
 * of its projects, workflows, labels and context), the previous owner a
 * manager. Refused while a run is active in any of its projects.
 */
export async function transferOrganization(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	orgId: string,
	body: { to_user_id?: unknown; expected_revision?: unknown }
): Promise<OrganizationDetail> {
	noRunKey(actor);
	browserOnly(actor, 'Transferring an organization');
	const access = await requireOrg(db, actor, orgId, ['owner']);
	if (access.org.kind !== 'shared')
		throw new ApiFail(
			422,
			'personal_organization',
			'A personal organization cannot be transferred'
		);
	const to = requireString(body.to_user_id, 'to_user_id', { max: 100 });
	const oldOwner = access.org.owner_user_id;
	const target = await db
		.selectFrom('organization_member')
		.select('role')
		.where('organization_id', '=', orgId)
		.where('user_id', '=', to)
		.where('revoked_at', 'is', null)
		.executeTakeFirst();
	if (!target || to === oldOwner)
		throw new ApiFail(422, 'not_a_manager', 'Transfer to a manager of this organization');
	const projects = await orgProjectIds(db, orgId);
	const busy = projects.length
		? await db
				.selectFrom('agent_run')
				.innerJoin('issue', 'issue.id', 'agent_run.issue_id')
				.select('agent_run.id')
				.where('issue.project_id', 'in', projects)
				.where('agent_run.status', 'in', ['assigned', 'launching', 'running'])
				.executeTakeFirst()
		: undefined;
	if (busy)
		throw new ApiFail(
			409,
			'runs_active',
			'A run is active in this organization; wait for it to finish, or hold its issue'
		);
	const now = Date.now();
	const inOrg = (col: string) =>
		sql<boolean>`COALESCE(${sql.ref(col)}, 'org_' || user_id) = ${orgId}`;
	const projectList = projects.length ? projects : ['__none__'];
	const actorRef = { userId: personOf(actor), apiKeyId: actor.apiKeyId };
	const claim = sql<boolean>`EXISTS (SELECT 1 FROM organization WHERE id = ${orgId} AND owner_user_id = ${to}
		AND revision = ${access.org.revision + 1})`;
	const queries: CompiledQuery[] = [
		db
			.updateTable('organization')
			.set({ owner_user_id: to, revision: access.org.revision + 1, updated_at: now })
			.where('id', '=', orgId)
			.where(
				'revision',
				'=',
				typeof body.expected_revision === 'number' ? body.expected_revision : access.org.revision
			)
			.where('owner_user_id', '=', oldOwner)
			.compile(),
		sql`UPDATE organization_member SET role = 'manager', updated_at = ${now}
			WHERE organization_id = ${orgId} AND user_id = ${oldOwner} AND ${claim}`.compile(db),
		sql`UPDATE organization_member SET role = 'owner', updated_at = ${now}
			WHERE organization_id = ${orgId} AND user_id = ${to} AND ${claim}`.compile(db),
		// Everything the organization holds moves to its new owner.
		sql`UPDATE context_item SET user_id = ${to} WHERE user_id = ${oldOwner} AND (
			project_id IN (SELECT value FROM json_each(${JSON.stringify(projectList)}))
			OR issue_id IN (SELECT id FROM issue WHERE project_id IN (SELECT value FROM json_each(${JSON.stringify(projectList)})))
			OR (project_id IS NULL AND issue_id IS NULL AND ${inOrg('organization_id')})) AND ${claim}`.compile(
			db
		),
		sql`UPDATE workflow SET user_id = ${to} WHERE user_id = ${oldOwner} AND ${inOrg('organization_id')} AND ${claim}`.compile(
			db
		),
		sql`UPDATE label SET user_id = ${to} WHERE user_id = ${oldOwner} AND ${inOrg('organization_id')} AND ${claim}`.compile(
			db
		),
		sql`UPDATE event SET user_id = ${to} WHERE user_id = ${oldOwner}
			AND project_id IN (SELECT value FROM json_each(${JSON.stringify(projectList)})) AND ${claim}`.compile(
			db
		),
		sql`UPDATE project SET organization_id = ${orgId}, user_id = ${to}, updated_at = ${now}
			WHERE id IN (SELECT value FROM json_each(${JSON.stringify(projectList)})) AND ${claim}`.compile(db)
	];
	// The new owner stops being a member; the old owner becomes one.
	for (const projectId of projects) {
		queries.push(
			sql`UPDATE project_member SET revision = revision + 1, revoked_at = ${now}, updated_at = ${now}
				WHERE project_id = ${projectId} AND user_id = ${to} AND revoked_at IS NULL AND ${claim}`.compile(
				db
			),
			...grantProjectMemberQueries(db, projectId, oldOwner, actorRef, now, claim)
		);
	}
	queries.push(sql`SELECT 1 AS ok WHERE ${claim}`.compile(db));
	const results = await runAtomic(env, queries);
	if (!results.at(-1)?.results?.length)
		throw new ApiFail(
			409,
			'organization_changed',
			'The organization changed; reload and try again'
		);
	return getOrganization(db, actor, orgId);
}

/**
 * Deletes a shared organization. Its projects must be empty of issues (move
 * them out first); empty projects, and the organization's workflows, labels,
 * context and invitations, are deleted with it.
 */
export async function deleteOrganization(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	orgId: string,
	body: { confirm_name?: unknown }
) {
	noRunKey(actor);
	browserOnly(actor, 'Deleting an organization');
	const access = await requireOrg(db, actor, orgId, ['owner']);
	if (access.org.kind !== 'shared')
		throw new ApiFail(422, 'personal_organization', 'A personal organization cannot be deleted');
	if (body.confirm_name !== access.org.name)
		throw new ApiFail(422, 'confirm_name', 'Type the organization’s name to confirm', {
			field: 'confirm_name'
		});
	const detail = await getOrganization(db, actor, orgId);
	const busy = detail.projects.filter((p) => p.issue_count > 0);
	if (busy.length)
		throw new ApiFail(
			409,
			'organization_not_empty',
			`Move these projects out first: ${busy.map((p) => p.name).join(', ')}`,
			{ projects: busy.map((p) => ({ id: p.id, name: p.name, issue_count: p.issue_count })) }
		);
	const owner = access.org.owner_user_id;
	const projectIds = detail.projects.map((p) => p.id);
	const ids = projectIds.length ? projectIds : ['__none__'];
	const list = JSON.stringify(ids);
	const inOrg = sql<boolean>`COALESCE(organization_id, 'org_' || user_id) = ${orgId}`;
	const orgStates = sql`(SELECT s.id FROM workflow_state s JOIN workflow w ON w.id = s.workflow_id
		WHERE w.user_id = ${owner} AND COALESCE(w.organization_id, 'org_' || w.user_id) = ${orgId})`;
	await runAtomic(env, [
		sql`DELETE FROM context_item_file WHERE context_item_id IN (SELECT id FROM context_item WHERE user_id = ${owner}
			AND (project_id IN (SELECT value FROM json_each(${list})) OR (project_id IS NULL AND ${inOrg})
			OR workflow_state_id IN ${orgStates}))`.compile(db),
		sql`DELETE FROM context_item WHERE user_id = ${owner} AND (project_id IN (SELECT value FROM json_each(${list}))
			OR (project_id IS NULL AND ${inOrg}) OR workflow_state_id IN ${orgStates})`.compile(db),
		sql`DELETE FROM routing_rule WHERE project_id IN (SELECT value FROM json_each(${list}))
			OR workflow_state_id IN ${orgStates}`.compile(db),
		sql`DELETE FROM scheduled_task WHERE project_id IN (SELECT value FROM json_each(${list}))`.compile(
			db
		),
		sql`DELETE FROM pack WHERE project_id IN (SELECT value FROM json_each(${list}))`.compile(db),
		sql`UPDATE project SET default_workflow_id = NULL WHERE id IN (SELECT value FROM json_each(${list}))`.compile(
			db
		),
		sql`DELETE FROM project_member WHERE project_id IN (SELECT value FROM json_each(${list}))`.compile(
			db
		),
		sql`DELETE FROM project_invitation WHERE project_id IN (SELECT value FROM json_each(${list}))`.compile(
			db
		),
		sql`DELETE FROM project WHERE id IN (SELECT value FROM json_each(${list}))`.compile(db),
		sql`UPDATE workflow_state SET inherits_from_state_id = NULL WHERE inherits_from_state_id IN ${orgStates}`.compile(
			db
		),
		sql`DELETE FROM workflow_transition WHERE workflow_id IN (SELECT id FROM workflow WHERE user_id = ${owner} AND ${inOrg})`.compile(
			db
		),
		sql`DELETE FROM workflow_state WHERE workflow_id IN (SELECT id FROM workflow WHERE user_id = ${owner} AND ${inOrg})`.compile(
			db
		),
		sql`DELETE FROM workflow WHERE user_id = ${owner} AND ${inOrg}`.compile(db),
		sql`DELETE FROM label WHERE user_id = ${owner} AND ${inOrg}`.compile(db),
		db.deleteFrom('organization_invitation').where('organization_id', '=', orgId).compile(),
		db.deleteFrom('organization_member').where('organization_id', '=', orgId).compile(),
		db.deleteFrom('organization').where('id', '=', orgId).compile()
	]);
	return { deleted: true, projects_deleted: projectIds.length };
}

/** Member ids for a project move (exported for the move module). */
export { orgMemberIds };
