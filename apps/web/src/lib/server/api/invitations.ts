import { sql, type Kysely } from 'kysely';
import { sha256Hex } from '$lib/server/crypto';
import { newId, type Database } from '$lib/server/db';
import { ApiFail, notFound, requireString, runAtomic, type ActorContext } from './core';
import { assertCapability, resolveProjectAccess } from './project-access';
import { recordIsolatedInvitation, sendInvitationEmail } from './invitation-email';
import { requireAccess } from './permissions';

function requirePeopleWrite(actor: ActorContext, projectId: string) {
	requireAccess(
		actor,
		[{ domain: 'project', access: 'write', projectId }],
		'project.people.write',
		{
			projectId
		}
	);
}

const WEEK = 7 * 24 * 60 * 60 * 1000;
function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function emailAddress(value: unknown): string {
	const email = requireString(value, 'email', { max: 320 }).trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
		throw new ApiFail(422, 'invalid_email', 'Enter a valid email address');
	return email;
}
function generation(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1)
		throw new ApiFail(422, 'invalid_field', 'Expected generation is required');
	return value as number;
}
function noRunKey(actor: ActorContext) {
	if (actor.agentRunId)
		throw new ApiFail(403, 'run_key_forbidden', 'Run keys cannot manage people');
}

export async function listPeople(db: Kysely<Database>, actor: ActorContext, projectId: string) {
	noRunKey(actor);
	const access = await resolveProjectAccess(db, actor, projectId);
	const project = await db
		.selectFrom('project as p')
		.innerJoin('user as u', 'u.id', 'p.user_id')
		.select(['p.user_id as id', 'u.name', 'p.shared_at'])
		.where('p.id', '=', projectId)
		.executeTakeFirstOrThrow();
	const members = await db
		.selectFrom('project_member as m')
		.innerJoin('user as u', 'u.id', 'm.user_id')
		.select(['m.user_id as id', 'u.name', 'm.revision', 'm.joined_at'])
		.where('m.project_id', '=', projectId)
		.where('m.revoked_at', 'is', null)
		.orderBy('m.joined_at')
		.execute();
	if (
		access.role === 'member' &&
		(await resolveProjectAccess(db, actor, projectId)).membershipRevision !==
			access.membershipRevision
	)
		throw notFound();
	return {
		owner: { id: project.id, name: project.name },
		members,
		shared_at: project.shared_at,
		viewer_id: actor.userId
	};
}

export async function listInvitations(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string
) {
	noRunKey(actor);
	assertCapability(await resolveProjectAccess(db, actor, projectId), 'invite');
	requirePeopleWrite(actor, projectId);
	return db
		.selectFrom('project_invitation')
		.select([
			'id',
			'email',
			'generation',
			'expires_at',
			'landing_issue_id',
			'accepted_at',
			'canceled_at',
			'delivery_status',
			'created_at'
		])
		.where('project_id', '=', projectId)
		.orderBy('created_at desc')
		.execute();
}

export async function createInvitation(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	body: {
		email?: unknown;
		landing_issue_id?: unknown;
		confirm_sharing?: unknown;
		expected_sharing_revision?: unknown;
	},
	origin: string,
	beforeCommit?: () => Promise<void>,
	triedSharedRetry = false
) {
	noRunKey(actor);
	const access = await resolveProjectAccess(db, actor, projectId);
	assertCapability(access, 'invite');
	requirePeopleWrite(actor, projectId);
	if (access.archivedAt !== null)
		throw new ApiFail(422, 'project_archived', 'Unarchive the project before inviting people');
	const email = emailAddress(body.email);
	const expected = body.expected_sharing_revision;
	if (!Number.isSafeInteger(expected) || expected !== access.sharingRevision)
		throw new ApiFail(409, 'sharing_changed', 'Project sharing changed; refresh before inviting', {
			committed: false,
			current_revision: access.sharingRevision
		});
	const project = await db
		.selectFrom('project as p')
		.innerJoin('user as u', 'u.id', 'p.user_id')
		.select(['p.name', 'p.shared_at', 'u.name as owner_name', 'u.email as owner_email'])
		.where('p.id', '=', projectId)
		.executeTakeFirstOrThrow();
	if (project.owner_email.trim().toLowerCase() === email)
		throw new ApiFail(422, 'self_invite', 'The owner already belongs to this project');
	if (project.shared_at === null && body.confirm_sharing !== true)
		throw new ApiFail(
			409,
			'confirm_sharing_required',
			'Confirm that existing issues and schedules will start with personal permission off and assigned work will wait.',
			{ committed: false, issue_and_schedule_permissions_reset: true }
		);
	const active = await db
		.selectFrom('project_member as m')
		.innerJoin('user as u', 'u.id', 'm.user_id')
		.select('m.user_id')
		.where('m.project_id', '=', projectId)
		.where('m.revoked_at', 'is', null)
		.where(sql<boolean>`lower(u.email) = ${email}`)
		.executeTakeFirst();
	if (active) throw new ApiFail(409, 'already_member', 'This person is already a member');
	const pending = await db
		.selectFrom('project_invitation')
		.select('id')
		.where('project_id', '=', projectId)
		.where('email', '=', email)
		.where('accepted_at', 'is', null)
		.where('canceled_at', 'is', null)
		.executeTakeFirst();
	if (pending)
		throw new ApiFail(
			409,
			'invite_pending',
			'An invitation is already pending; resend it to rotate its link',
			{ invite_id: pending.id }
		);
	let landingIssueId: string | null = null;
	if (body.landing_issue_id != null) {
		landingIssueId = requireString(body.landing_issue_id, 'landing_issue_id', { max: 100 });
		const landing = await db
			.selectFrom('issue')
			.select('id')
			.where('id', '=', landingIssueId)
			.where('project_id', '=', projectId)
			.executeTakeFirst();
		if (!landing)
			throw new ApiFail(422, 'invalid_landing_issue', 'Landing issue must belong to this project');
	}
	const now = Date.now(),
		expiresAt = now + WEEK,
		id = newId('inv'),
		token = randomToken(),
		hash = await sha256Hex(token);
	const insert =
		sql`INSERT INTO project_invitation (id, project_id, email, token_hash, generation, expires_at,
		landing_issue_id, created_by_user_id, created_by_api_key_id, created_at, updated_at, delivery_status)
		SELECT ${id}, p.id, ${email}, ${hash}, 1, ${expiresAt}, ${landingIssueId}, ${actor.userId}, ${actor.apiKeyId}, ${now}, ${now}, 'pending'
		FROM project p WHERE p.id = ${projectId} AND p.user_id = ${actor.userId} AND p.archived_at IS NULL
		AND p.sharing_revision = ${access.sharingRevision}`.compile(db);
	const receipt = sql<boolean>`EXISTS (SELECT 1 FROM project_invitation WHERE id = ${id})`;
	const queries = [insert];
	if (project.shared_at === null) {
		queries.push(
			sql`UPDATE project SET shared_at = ${now}, sharing_revision = sharing_revision + 1, updated_at = ${now}
			WHERE id = ${projectId} AND shared_at IS NULL AND sharing_revision = ${access.sharingRevision} AND ${receipt}`.compile(
				db
			)
		);
		queries.push(
			sql`UPDATE issue_personal_choice SET value = 'unset', revision = revision + 1, updated_at = ${now}
			WHERE issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId}) AND ${receipt}`.compile(db)
		);
		queries.push(
			sql`UPDATE schedule_personal_choice SET value = 'off', revision = revision + 1, updated_at = ${now}
			WHERE schedule_id IN (SELECT id FROM scheduled_task WHERE project_id = ${projectId}) AND ${receipt}`.compile(
				db
			)
		);
		const releaseToken = newId('rel');
		queries.push(
			sql`UPDATE agent_run SET status = 'canceled', outcome = NULL, ended_at = ${now},
			error = 'First sharing requires fresh personal permission', assignment_release_token = ${releaseToken}
			WHERE status = 'assigned' AND issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId}) AND ${receipt}`.compile(
				db
			)
		);
		queries.push(
			sql`UPDATE api_key SET revoked_at = ${now} WHERE revoked_at IS NULL AND agent_run_id IN
			(SELECT id FROM agent_run WHERE assignment_release_token = ${releaseToken})`.compile(db)
		);
		queries.push(
			sql`INSERT INTO event (id,user_id,type,actor_user_id,actor_api_key_id,project_id,payload,created_at)
			SELECT ${newId('evt')}, ${actor.userId}, 'project.sharing_started', ${actor.userId}, ${actor.apiKeyId},
			${projectId}, '{}', ${now} WHERE ${receipt}`.compile(db)
		);
	}
	queries.push(
		sql`INSERT INTO event (id,user_id,type,actor_user_id,actor_api_key_id,project_id,payload,created_at)
		SELECT ${newId('evt')}, ${actor.userId}, 'project.invitation_created', ${actor.userId}, ${actor.apiKeyId},
		${projectId}, ${JSON.stringify({ invitation_id: id })}, ${now} WHERE ${receipt}`.compile(db)
	);
	queries.push(sql`SELECT id FROM project_invitation WHERE id = ${id}`.compile(db));
	await beforeCommit?.();
	const results = await runAtomic(env, queries);
	if (!results.at(-1)?.results?.length) {
		if (project.shared_at === null && !triedSharedRetry) {
			const latest = await db
				.selectFrom('project')
				.select(['user_id', 'archived_at', 'shared_at', 'sharing_revision'])
				.where('id', '=', projectId)
				.executeTakeFirst();
			if (
				latest?.shared_at !== null &&
				latest?.archived_at === null &&
				latest?.user_id === actor.userId
			)
				return createInvitation(
					db,
					env,
					actor,
					projectId,
					{ ...body, expected_sharing_revision: latest.sharing_revision },
					origin,
					undefined,
					true
				);
		}
		throw new ApiFail(409, 'sharing_changed', 'Project sharing changed; refresh before inviting', {
			committed: false
		});
	}
	const deliveryStatus = await deliver(db, env, {
		id,
		generation: 1,
		email,
		owner: project.owner_name,
		project: project.name,
		token,
		expiresAt,
		origin
	});
	return {
		id,
		email,
		generation: 1,
		expires_at: expiresAt,
		landing_issue_id: landingIssueId,
		delivery_status: deliveryStatus,
		shared_at: project.shared_at ?? now
	};
}

async function deliver(
	db: Kysely<Database>,
	env: Env,
	input: {
		id: string;
		generation: number;
		email: string;
		owner: string;
		project: string;
		token: string;
		expiresAt: number;
		origin: string;
	}
) {
	const current = await db
		.selectFrom('project_invitation')
		.select('id')
		.where('id', '=', input.id)
		.where('generation', '=', input.generation)
		.where('canceled_at', 'is', null)
		.executeTakeFirst();
	if (!current) return 'pending' as const;
	let status: 'sent' | 'failed' = 'sent';
	try {
		const url = `${input.origin}/invites/${input.token}`;
		await sendInvitationEmail(env, { ...input, url });
		recordIsolatedInvitation(input.id, url);
	} catch (error) {
		console.error('Invitation email failed:', error);
		status = 'failed';
	}
	await db
		.updateTable('project_invitation')
		.set({ delivery_status: status })
		.where('id', '=', input.id)
		.where('generation', '=', input.generation)
		.execute();
	return status;
}

export async function resendInvitation(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	inviteId: string,
	expectedGeneration: unknown,
	origin: string
) {
	noRunKey(actor);
	assertCapability(await resolveProjectAccess(db, actor, projectId), 'invite');
	requirePeopleWrite(actor, projectId);
	const current = await db
		.selectFrom('project_invitation as i')
		.innerJoin('project as p', 'p.id', 'i.project_id')
		.innerJoin('user as u', 'u.id', 'p.user_id')
		.select([
			'i.email',
			'i.generation',
			'i.accepted_at',
			'i.canceled_at',
			'p.name',
			'u.name as owner_name'
		])
		.where('i.id', '=', inviteId)
		.where('i.project_id', '=', projectId)
		.executeTakeFirst();
	if (!current) throw notFound();
	if (current.accepted_at !== null || current.canceled_at !== null)
		throw new ApiFail(409, 'invite_inactive', 'This invitation is no longer pending');
	const expected = generation(expectedGeneration),
		now = Date.now(),
		expiresAt = now + WEEK,
		token = randomToken();
	const result = await db
		.updateTable('project_invitation')
		.set({
			token_hash: await sha256Hex(token),
			generation: expected + 1,
			expires_at: expiresAt,
			updated_at: now,
			delivery_status: 'pending'
		})
		.where('id', '=', inviteId)
		.where('project_id', '=', projectId)
		.where('generation', '=', expected)
		.where('accepted_at', 'is', null)
		.where('canceled_at', 'is', null)
		.executeTakeFirst();
	if (Number(result.numUpdatedRows) !== 1)
		throw new ApiFail(409, 'invite_changed', 'Invitation changed; refresh before resending', {
			committed: false
		});
	const deliveryStatus = await deliver(db, env, {
		id: inviteId,
		generation: expected + 1,
		email: current.email,
		owner: current.owner_name,
		project: current.name,
		token,
		expiresAt,
		origin
	});
	return {
		id: inviteId,
		generation: expected + 1,
		expires_at: expiresAt,
		delivery_status: deliveryStatus
	};
}

export async function cancelInvitation(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string,
	inviteId: string,
	expectedGeneration: unknown
) {
	noRunKey(actor);
	assertCapability(await resolveProjectAccess(db, actor, projectId), 'invite');
	requirePeopleWrite(actor, projectId);
	const result = await db
		.updateTable('project_invitation')
		.set({ canceled_at: Date.now() })
		.where('id', '=', inviteId)
		.where('project_id', '=', projectId)
		.where('generation', '=', generation(expectedGeneration))
		.where('accepted_at', 'is', null)
		.where('canceled_at', 'is', null)
		.executeTakeFirst();
	if (Number(result.numUpdatedRows) !== 1)
		throw new ApiFail(409, 'invite_changed', 'Invitation changed; refresh before canceling', {
			committed: false
		});
}

export async function invitationLanding(db: Kysely<Database>, token: string, viewerId?: string) {
	if (!/^[a-f0-9]{64}$/.test(token)) throw notFound();
	const row = await db
		.selectFrom('project_invitation as i')
		.innerJoin('project as p', 'p.id', 'i.project_id')
		.innerJoin('user as owner', 'owner.id', 'p.user_id')
		.select([
			'i.id',
			'i.project_id',
			'i.email',
			'i.expires_at',
			'i.accepted_at',
			'i.accepted_by_user_id',
			'i.accepted_membership_revision',
			'i.canceled_at',
			'i.landing_issue_id',
			'p.name as project_name',
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
		project: { id: row.project_id, name: row.project_name, owner: row.owner_name },
		expires_at: row.expires_at,
		matching_account: matching,
		signed_in: !!viewerId,
		...(matching ? { email: row.email } : {}),
		landing_issue_id: matching ? row.landing_issue_id : null
	};
}

export async function acceptInvitation(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	token: string
) {
	if (!actor.viaSession || actor.bearerPresent || actor.apiKeyId || actor.agentRunId)
		throw new ApiFail(403, 'session_required', 'Open the invitation in your browser');
	if (!/^[a-f0-9]{64}$/.test(token)) throw notFound();
	const hash = await sha256Hex(token),
		now = Date.now();
	const invite = await db
		.selectFrom('project_invitation as i')
		.innerJoin('project as p', 'p.id', 'i.project_id')
		.innerJoin('user as u', (join) => join.on('u.id', '=', actor.userId))
		.leftJoin('project_member as m', (join) =>
			join.onRef('m.project_id', '=', 'i.project_id').on('m.user_id', '=', actor.userId)
		)
		.select([
			'i.id',
			'i.project_id',
			'i.email',
			'i.expires_at',
			'i.accepted_at',
			'i.accepted_by_user_id',
			'i.accepted_membership_revision',
			'i.canceled_at',
			'i.landing_issue_id',
			'p.user_id as owner_id',
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
	const landing = invite.landing_issue_id
		? await db
				.selectFrom('issue')
				.select('number')
				.where('id', '=', invite.landing_issue_id)
				.where('project_id', '=', invite.project_id)
				.executeTakeFirst()
		: null;
	const landingPath = landing
		? `/issues/${encodeURIComponent(invite.project_id)}/${landing.number}`
		: `/issues?project=${encodeURIComponent(invite.project_id)}&category=awaiting_human`;
	if (invite.accepted_at !== null) {
		if (
			invite.accepted_by_user_id === actor.userId &&
			invite.member_revision === invite.accepted_membership_revision &&
			invite.revoked_at === null
		)
			return {
				project_id: invite.project_id,
				landing_path: landingPath,
				membership_revision: invite.member_revision,
				already_accepted: true
			};
		throw notFound();
	}
	if (invite.expires_at <= now)
		throw new ApiFail(410, 'invite_expired', 'This invitation expired; ask the owner to resend it');
	if (invite.owner_id === actor.userId)
		throw new ApiFail(
			403,
			'owner_already_joined',
			'The project owner is already part of the project'
		);
	const revision = (invite.member_revision ?? 0) + 1;
	const queries = [
		sql`INSERT INTO project_member (project_id,user_id,revision,joined_at,revoked_at,updated_at)
			SELECT ${invite.project_id}, ${actor.userId}, ${revision}, ${now}, NULL, ${now}
			WHERE EXISTS (SELECT 1 FROM project_invitation WHERE id = ${invite.id} AND token_hash = ${hash}
				AND accepted_at IS NULL AND canceled_at IS NULL AND expires_at > ${now})
			ON CONFLICT(project_id,user_id) DO UPDATE SET revision = excluded.revision, joined_at = excluded.joined_at,
				revoked_at = NULL, updated_at = excluded.updated_at WHERE project_member.revoked_at IS NOT NULL
				AND project_member.revision = ${revision - 1}`.compile(db),
		sql`UPDATE project_invitation SET accepted_at = ${now}, accepted_by_user_id = ${actor.userId},
			accepted_membership_revision = ${revision}, updated_at = ${now}
			WHERE id = ${invite.id} AND token_hash = ${hash} AND accepted_at IS NULL AND canceled_at IS NULL
			AND expires_at > ${now} AND EXISTS (SELECT 1 FROM project_member WHERE project_id = ${invite.project_id}
				AND user_id = ${actor.userId} AND revision = ${revision} AND revoked_at IS NULL)`.compile(db),
		sql`INSERT INTO event (id,user_id,type,actor_user_id,actor_api_key_id,project_id,payload,created_at)
			SELECT ${newId('evt')}, ${invite.owner_id}, 'project.member_joined', ${actor.userId}, NULL,
			${invite.project_id}, ${JSON.stringify({ member_user_id: actor.userId, membership_revision: revision })}, ${now}
			WHERE EXISTS (SELECT 1 FROM project_invitation WHERE id = ${invite.id} AND accepted_at = ${now}
			AND accepted_by_user_id = ${actor.userId} AND accepted_membership_revision = ${revision})`.compile(
			db
		),
		sql`SELECT accepted_membership_revision FROM project_invitation WHERE id = ${invite.id} AND accepted_by_user_id = ${actor.userId}`.compile(
			db
		)
	];
	const result = await runAtomic(env, queries);
	if (!result.at(-1)?.results?.length)
		throw new ApiFail(409, 'invite_changed', 'Invitation changed; refresh before accepting', {
			committed: false
		});
	return {
		project_id: invite.project_id,
		landing_path: landingPath,
		membership_revision: revision,
		already_accepted: false
	};
}

export async function removeMember(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	memberId: string,
	expectedRevision: unknown
) {
	noRunKey(actor);
	const access = await resolveProjectAccess(db, actor, projectId);
	if (actor.userId !== memberId) {
		assertCapability(access, 'invite');
		requirePeopleWrite(actor, projectId);
	} else assertCapability(access, 'leave');
	if (memberId === access.ownerId)
		throw new ApiFail(403, 'owner_cannot_leave', 'The project owner cannot leave');
	if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1)
		throw new ApiFail(422, 'invalid_field', 'Expected membership revision is required');
	const revision = expectedRevision as number,
		now = Date.now(),
		cancelToken = newId('cancel'),
		requestToken = newId('mem');
	const guard = sql<boolean>`EXISTS (SELECT 1 FROM project_member WHERE project_id = ${projectId}
		AND user_id = ${memberId} AND revision = ${revision + 1} AND last_request_token = ${requestToken})`;
	const queries = [
		sql`UPDATE project_member SET revision = revision + 1, revoked_at = ${now}, updated_at = ${now}, last_request_token = ${requestToken}
			WHERE project_id = ${projectId} AND user_id = ${memberId} AND revision = ${revision} AND revoked_at IS NULL
			AND (${actor.userId} = ${memberId} OR EXISTS (SELECT 1 FROM project WHERE id = ${projectId} AND user_id = ${actor.userId}))`.compile(
			db
		),
		sql`UPDATE project_invitation SET canceled_at = ${now}, updated_at = ${now} WHERE project_id = ${projectId}
			AND email = (SELECT lower(email) FROM user WHERE id = ${memberId}) AND canceled_at IS NULL AND ${guard}`.compile(
			db
		),
		sql`UPDATE issue_personal_choice SET value = 'unset', revision = revision + 1, updated_at = ${now}
			WHERE user_id = ${memberId} AND issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId}) AND ${guard}`.compile(
			db
		),
		sql`UPDATE schedule_personal_choice SET value = 'off', revision = revision + 1, updated_at = ${now}
			WHERE user_id = ${memberId} AND schedule_id IN (SELECT id FROM scheduled_task WHERE project_id = ${projectId}) AND ${guard}`.compile(
			db
		),
		sql`UPDATE agent_run SET status = 'canceled', ended_at = ${now}, assignment_release_token = ${cancelToken}
			WHERE user_id = ${memberId} AND status = 'assigned' AND issue_id IN
			(SELECT id FROM issue WHERE project_id = ${projectId}) AND ${guard}`.compile(db),
		sql`UPDATE agent_run SET cancel_requested_at = ${now}, cancel_requested_by_user_id = ${actor.userId},
			cancel_reason = 'Project membership removed', cancellation_token = ${cancelToken}
			WHERE user_id = ${memberId} AND status IN ('launching','running') AND cancel_requested_at IS NULL
			AND issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId}) AND ${guard}`.compile(db),
		sql`UPDATE api_key SET revoked_at = ${now} WHERE agent_run_id IN (SELECT id FROM agent_run
			WHERE user_id = ${memberId} AND issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})
			AND (assignment_release_token = ${cancelToken} OR cancel_requested_at IS NOT NULL)) AND revoked_at IS NULL AND ${guard}`.compile(
			db
		),
		sql`INSERT INTO event (id,user_id,type,actor_user_id,actor_api_key_id,project_id,payload,created_at)
			SELECT ${newId('evt')}, ${access.ownerId}, 'project.member_removed', ${actor.userId}, ${actor.apiKeyId},
			${projectId}, ${JSON.stringify({ member_user_id: memberId, membership_revision: revision + 1 })}, ${now}
			WHERE ${guard}`.compile(db),
		sql`SELECT revision FROM project_member WHERE project_id = ${projectId} AND user_id = ${memberId}
			AND revision = ${revision + 1} AND last_request_token = ${requestToken}`.compile(db)
	];
	const result = await runAtomic(env, queries);
	if (!result.at(-1)?.results?.length)
		throw new ApiFail(409, 'member_changed', 'Membership changed; refresh before removing', {
			committed: false
		});
	return { project_id: projectId, user_id: memberId, revision: revision + 1, revoked_at: now };
}
