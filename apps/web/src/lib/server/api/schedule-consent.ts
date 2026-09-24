import type {
	ScheduleConsentReceipt,
	ScheduleConsentRequest,
	SharedScheduleSummary,
	SchedulePreset
} from '@tines/shared';
import { sql, type CompiledQuery, type Kysely, type RawBuilder } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { ApiFail, notFound, runAtomic, type ActorContext } from './core';
import { eventInsert } from './events';

/** Current personal subject, intersected with durable project membership. */
export function scheduleSubjectPredicate(scheduleAlias: string, userId: string) {
	return sql<boolean>`EXISTS (SELECT 1 FROM project p WHERE p.id = ${sql.ref(`${scheduleAlias}.project_id`)}
		AND p.shared_at IS NOT NULL AND (p.user_id = ${userId} OR EXISTS (
			SELECT 1 FROM project_member m WHERE m.project_id = p.id
				AND m.user_id = ${userId} AND m.revoked_at IS NULL)))`;
}

/** Safe, person-relative schedule view for the later shared-project loader. */
export async function readSharedScheduleSummary(
	db: Kysely<Database>,
	actor: ActorContext,
	scheduleId: string,
	keyMayRead: (projectId: string) => Promise<boolean> = async () => false
): Promise<SharedScheduleSummary> {
	const row = await db
		.selectFrom('scheduled_task as s')
		.innerJoin('project as p', 'p.id', 's.project_id')
		.innerJoin('user as owner', 'owner.id', 'p.user_id')
		.innerJoin('workflow as w', 'w.id', 's.workflow_id')
		.innerJoin('workflow_state as start', (join) =>
			join.on((eb) => eb('start.id', '=', eb.fn.coalesce('s.state_id', 'w.initial_state_id')))
		)
		.select([
			's.id',
			's.project_id',
			's.name',
			's.title_template',
			's.description_template',
			's.cron',
			's.preset',
			's.timezone',
			's.require_all_closed',
			's.enabled',
			's.permission_epoch',
			's.workflow_id',
			's.state_id',
			'p.name as project_name',
			'p.user_id as owner_id',
			'p.archived_at',
			'owner.name as owner_name',
			'w.name as workflow_name',
			'start.id as start_state_id',
			'start.name as start_state_name'
		])
		.where('s.id', '=', scheduleId)
		.where(scheduleSubjectPredicate('s', actor.userId))
		.executeTakeFirst();
	if (!row) throw notFound();
	if (
		(!actor.viaSession || actor.bearerPresent) &&
		actor.userId !== row.owner_id &&
		!(await keyMayRead(row.project_id))
	)
		throw notFound();
	const people = await db
		.selectFrom('user as u')
		.leftJoin('project_member as m', (join) =>
			join.onRef('m.user_id', '=', 'u.id').on('m.project_id', '=', row.project_id)
		)
		.leftJoin('schedule_personal_choice as c', (join) =>
			join.onRef('c.user_id', '=', 'u.id').on('c.schedule_id', '=', row.id)
		)
		.select([
			'u.id',
			'u.name',
			'm.revision as member_revision',
			'm.joined_at',
			'c.value',
			'c.revision as choice_revision',
			'c.permission_epoch as choice_epoch',
			'c.membership_revision as choice_member_revision'
		])
		.where((eb) =>
			eb.or([
				eb('u.id', '=', row.owner_id),
				eb.and([eb('m.revoked_at', 'is', null), eb('m.joined_at', 'is not', null)])
			])
		)
		.orderBy('u.name asc')
		.orderBy('u.id asc')
		.execute();
	const roster = people.map((person) => {
		const owner = person.id === row.owner_id;
		const valid =
			person.choice_epoch === row.permission_epoch &&
			person.choice_member_revision === (owner ? 0 : person.member_revision);
		return {
			user: { id: person.id, name: person.name },
			role: owner ? ('owner' as const) : ('member' as const),
			value: valid ? (person.value ?? 'unset') : ('unset' as const),
			revision: person.choice_revision ?? 0
		};
	});
	roster.sort((a, b) =>
		a.role === b.role ? a.user.name.localeCompare(b.user.name) : a.role === 'owner' ? -1 : 1
	);
	const own = roster.find((person) => person.user.id === actor.userId);
	let preset: SchedulePreset | null = null;
	try {
		preset = row.preset ? (JSON.parse(row.preset) as SchedulePreset) : null;
	} catch {
		/* corrupted preset is not permission */
	}
	return {
		id: row.id,
		viewer_id: actor.userId,
		project: {
			id: row.project_id,
			name: row.project_name,
			owner: { id: row.owner_id, name: row.owner_name },
			archived_at: row.archived_at
		},
		name: row.name,
		title_template: row.title_template,
		description_template: row.description_template,
		workflow: {
			id: row.workflow_id,
			name: row.workflow_name,
			start_state_id: row.start_state_id,
			start_state_name: row.start_state_name
		},
		recurrence: {
			cron: row.cron,
			preset,
			timezone: row.timezone,
			require_all_closed: Boolean(row.require_all_closed),
			enabled: Boolean(row.enabled)
		},
		permission_epoch: row.permission_epoch,
		my_future_permission: {
			value: own?.value ?? 'unset',
			revision: own?.revision ?? 0,
			epoch: row.permission_epoch
		},
		roster: roster.map(({ user, role, value }) => ({ user, role, value }))
	};
}

export async function readScheduleConsent(
	db: Kysely<Database>,
	userId: string,
	scheduleId: string
): Promise<ScheduleConsentReceipt> {
	const row = await db
		.selectFrom('scheduled_task as s')
		.innerJoin('project as p', 'p.id', 's.project_id')
		.leftJoin('schedule_personal_choice as c', (join) =>
			join.onRef('c.schedule_id', '=', 's.id').on('c.user_id', '=', userId)
		)
		.leftJoin('project_member as m', (join) =>
			join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', userId)
		)
		.select([
			's.id',
			's.project_id',
			's.permission_epoch',
			's.enabled',
			'p.archived_at',
			'p.shared_at',
			'c.value',
			'c.revision',
			'c.permission_epoch as choice_epoch',
			'p.user_id as owner_id',
			'm.revision as member_revision',
			'c.membership_revision as choice_member_revision'
		])
		.where('s.id', '=', scheduleId)
		.where((eb) =>
			eb.or([
				eb('p.user_id', '=', userId),
				eb.and([
					eb('p.shared_at', 'is not', null),
					eb('m.revision', 'is not', null),
					eb('m.revoked_at', 'is', null)
				])
			])
		)
		.executeTakeFirst();
	if (!row) throw notFound();
	if (row.shared_at === null)
		throw new ApiFail(
			409,
			'consent_mode_required',
			'Future permission is available after project sharing begins'
		);
	return {
		schedule_id: row.id,
		project_id: row.project_id,
		my_future_permission: {
			value:
				row.choice_epoch === row.permission_epoch &&
				row.choice_member_revision === (row.owner_id === userId ? 0 : row.member_revision)
					? (row.value ?? 'unset')
					: 'unset',
			revision: row.revision ?? 0,
			epoch: row.permission_epoch
		},
		readiness: row.archived_at !== null ? 'archived' : row.enabled ? 'saved' : 'paused',
		message:
			row.owner_id === userId
				? 'Future permission is saved separately from each issue. Only the owner’s approved agents can run in this release.'
				: 'Permission saved. Member execution is not available in this release; only the owner’s approved agents can run.'
	};
}

/**
 * Revokes only still-inherited grants; an independent issue choice survives.
 *
 * An inherited on becomes unset, which for the owner is still on (the owner's
 * permission defaults on) — except when the owner has just turned the
 * schedule's future permission off (`ownerTurnedOff`), which turns the owner's
 * inherited grants off too. An inherited owner off is never cleared here: an
 * explicit off outlives the schedule's deletion or a definition change.
 */
export function revokeInheritedScheduleQueries(
	db: Kysely<Database>,
	scheduleId: string,
	now: number,
	guard: RawBuilder<boolean>,
	userId?: string,
	ownerTurnedOff = false
): CompiledQuery[] {
	const subject = userId ? sql`AND ipc.user_id = ${userId}` : sql``;
	const releaseToken = newId('rel');
	const cleared = ownerTurnedOff
		? sql`CASE WHEN ipc.user_id = (SELECT p.user_id FROM scheduled_task s
				JOIN project p ON p.id = s.project_id WHERE s.id = ${scheduleId})
			THEN 'off' ELSE 'unset' END`
		: sql`'unset'`;
	return [
		sql`UPDATE issue_personal_choice AS ipc SET value = ${cleared}, revision = revision + 1,
			source_kind = NULL, source_schedule_id = NULL, source_grant_revision = NULL,
			source_permission_epoch = NULL, updated_at = ${now}
		WHERE ipc.source_kind = 'schedule' AND ipc.source_schedule_id = ${scheduleId}
			AND ipc.value = 'on' ${subject} AND ${guard}`.compile(db),
		sql`UPDATE agent_run SET status = 'canceled', outcome = NULL, ended_at = ${now},
			error = 'Inherited schedule permission ended before admission',
			assignment_release_token = ${releaseToken}
		WHERE status = 'assigned' AND issue_id IN (
			SELECT ipc.issue_id FROM issue_personal_choice ipc
			WHERE ipc.source_kind = 'schedule' AND ipc.source_schedule_id = ${scheduleId}
				AND ipc.user_id = agent_run.user_id ${subject}
		) AND ${guard}`.compile(db),
		sql`UPDATE api_key SET revoked_at = ${now}
		WHERE revoked_at IS NULL AND agent_run_id IN
			(SELECT id FROM agent_run WHERE assignment_release_token = ${releaseToken})`.compile(db)
	];
}

/** Called after a guarded semantic update, using its unique token as commit witness. */
export function invalidateSchedulePermissionQueries(
	db: Kysely<Database>,
	scheduleId: string,
	token: string,
	now: number
): CompiledQuery[] {
	const guard = sql<boolean>`EXISTS (SELECT 1 FROM scheduled_task
		WHERE id = ${scheduleId} AND last_update_token = ${token})`;
	// Release first, while the source still identifies inherited rows.
	const [clear, release, revokeKeys] = revokeInheritedScheduleQueries(db, scheduleId, now, guard);
	return [
		release,
		revokeKeys,
		clear,
		// Members start over at off. The owner keeps their choice under the new
		// epoch: on is the owner's default anyway, and an explicit off must not
		// turn back on because the schedule changed.
		sql`UPDATE schedule_personal_choice SET value = CASE WHEN user_id = (
				SELECT p.user_id FROM scheduled_task s JOIN project p ON p.id = s.project_id
				WHERE s.id = ${scheduleId}) THEN value ELSE 'off' END,
			revision = revision + 1,
			permission_epoch = (SELECT permission_epoch FROM scheduled_task WHERE id = ${scheduleId}),
			updated_at = ${now}
		WHERE schedule_id = ${scheduleId} AND ${guard}`.compile(db)
	];
}

/** Set-based invalidation for workflows whose effective schedule start changed. */
export function invalidateWorkflowSchedulePermissionQueries(
	db: Kysely<Database>,
	token: string,
	now: number
): CompiledQuery[] {
	const releaseToken = newId('rel');
	const affected = sql`SELECT id FROM scheduled_task WHERE last_update_token = ${token}`;
	return [
		sql`UPDATE agent_run SET status = 'canceled', outcome = NULL, ended_at = ${now},
			error = 'Schedule starting state changed before admission',
			assignment_release_token = ${releaseToken}
		WHERE status = 'assigned' AND issue_id IN (
			SELECT issue_id FROM issue_personal_choice
			WHERE source_kind = 'schedule' AND source_schedule_id IN (${affected})
				AND user_id = agent_run.user_id
		)`.compile(db),
		sql`UPDATE api_key SET revoked_at = ${now} WHERE revoked_at IS NULL
			AND agent_run_id IN (SELECT id FROM agent_run
				WHERE assignment_release_token = ${releaseToken})`.compile(db),
		sql`UPDATE issue_personal_choice SET value = 'unset', revision = revision + 1,
			source_kind = NULL, source_schedule_id = NULL, source_grant_revision = NULL,
			source_permission_epoch = NULL, updated_at = ${now}
		WHERE source_kind = 'schedule' AND source_schedule_id IN (${affected})
			AND value = 'on'`.compile(db),
		// As invalidateSchedulePermissionQueries: members start over at off, the
		// owner keeps their choice.
		sql`UPDATE schedule_personal_choice SET value = CASE WHEN user_id = (
				SELECT p.user_id FROM scheduled_task s JOIN project p ON p.id = s.project_id
				WHERE s.id = schedule_personal_choice.schedule_id) THEN value ELSE 'off' END,
			revision = revision + 1,
			permission_epoch = (SELECT permission_epoch FROM scheduled_task
				WHERE id = schedule_personal_choice.schedule_id), updated_at = ${now}
		WHERE schedule_id IN (${affected})`.compile(db)
	];
}

export async function writeScheduleConsent(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	scheduleId: string,
	body: ScheduleConsentRequest
): Promise<ScheduleConsentReceipt> {
	if (!actor.viaSession || actor.bearerPresent)
		throw new ApiFail(
			403,
			'consent_browser_required',
			'Personal permission can only be changed in an authenticated browser session; open the schedule in Tines to choose.'
		);
	for (const field of ['user_id', 'subject_user_id', 'actor_user_id']) {
		if (field in body)
			throw new ApiFail(
				422,
				'invalid_field',
				'Personal permission always belongs to the signed-in person',
				{ field }
			);
	}
	if (body.value !== 'on' && body.value !== 'off')
		throw new ApiFail(422, 'invalid_field', '"value" must be "on" or "off"', { field: 'value' });
	if (
		body.disclosure_version !== undefined &&
		(!Number.isInteger(body.disclosure_version) ||
			body.disclosure_version < 1 ||
			body.value !== 'on')
	)
		throw new ApiFail(422, 'invalid_field', 'Disclosure version requires an on choice', {
			field: 'disclosure_version'
		});
	if (
		!Number.isInteger(body.expected_revision) ||
		body.expected_revision < 0 ||
		!Number.isInteger(body.permission_epoch) ||
		body.permission_epoch < 0
	)
		throw new ApiFail(
			422,
			'invalid_field',
			'Expected revision and permission epoch must be non-negative integers'
		);
	const current = await readScheduleConsent(db, actor.userId, scheduleId);
	if (
		current.my_future_permission.revision !== body.expected_revision ||
		current.my_future_permission.epoch !== body.permission_epoch
	)
		throw new ApiFail(
			409,
			'conflict',
			'Schedule permission changed; refresh and make a fresh choice',
			{ committed: false }
		);
	const token = newId('dcn');
	const now = Date.now();
	const member = await db
		.selectFrom('scheduled_task as s')
		.innerJoin('project as p', 'p.id', 's.project_id')
		.leftJoin('project_member as m', (join) =>
			join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', actor.userId)
		)
		.select(['p.user_id as owner_id', 'm.revision as member_revision'])
		.where('s.id', '=', scheduleId)
		.executeTakeFirstOrThrow();
	const guard = sql<boolean>`EXISTS (SELECT 1 FROM schedule_personal_choice
		WHERE schedule_id = ${scheduleId} AND user_id = ${actor.userId}
			AND last_request_token = ${token} AND value = 'off')`;
	const [clear, release, revokeKeys] = revokeInheritedScheduleQueries(
		db,
		scheduleId,
		now,
		guard,
		actor.userId,
		member.owner_id === actor.userId
	);
	const results = await runAtomic(env, [
		sql`INSERT INTO schedule_personal_choice
			(schedule_id, user_id, value, revision, permission_epoch, membership_revision, last_request_token, updated_at)
		SELECT s.id, ${actor.userId}, ${body.value}, ${body.expected_revision + 1},
			s.permission_epoch, ${member.owner_id === actor.userId ? 0 : member.member_revision}, ${token}, ${now}
		FROM scheduled_task s JOIN project p ON p.id = s.project_id
		WHERE s.id = ${scheduleId} AND ${
			member.owner_id === actor.userId
				? sql<boolean>`p.user_id = ${actor.userId}`
				: sql<boolean>`EXISTS (SELECT 1 FROM project_member m WHERE m.project_id = p.id
				AND m.user_id = ${actor.userId} AND m.revision = ${member.member_revision} AND m.revoked_at IS NULL)`
		}
			AND p.shared_at IS NOT NULL AND s.permission_epoch = ${body.permission_epoch}
		ON CONFLICT(schedule_id, user_id) DO UPDATE SET
			value = excluded.value, revision = schedule_personal_choice.revision + 1,
			permission_epoch = excluded.permission_epoch,
			membership_revision = excluded.membership_revision,
			last_request_token = excluded.last_request_token, updated_at = excluded.updated_at
		WHERE schedule_personal_choice.revision = ${body.expected_revision}`.compile(db),
		...(body.value === 'off' ? [release, revokeKeys, clear] : []),
		...(body.value === 'on' && body.disclosure_version
			? [
					sql`INSERT INTO personal_disclosure (user_id, version, acknowledged_at)
				SELECT ${actor.userId}, ${body.disclosure_version}, ${now}
				WHERE EXISTS (SELECT 1 FROM schedule_personal_choice WHERE schedule_id = ${scheduleId}
					AND user_id = ${actor.userId} AND last_request_token = ${token})
				ON CONFLICT(user_id, version) DO NOTHING`.compile(db)
				]
			: []),
		eventInsert(
			db,
			actor,
			{
				type: 'scheduled_task.personal_permission_changed',
				projectId: current.project_id,
				payload: {
					schedule_id: scheduleId,
					value: body.value,
					revision: body.expected_revision + 1
				}
			},
			{
				predicate: sql<boolean>`EXISTS (SELECT 1 FROM schedule_personal_choice
			WHERE schedule_id = ${scheduleId} AND user_id = ${actor.userId}
				AND last_request_token = ${token})`
			}
		),
		sql`SELECT revision FROM schedule_personal_choice WHERE schedule_id = ${scheduleId}
			AND user_id = ${actor.userId} AND last_request_token = ${token}`.compile(db)
	]);
	if (results.at(-1)?.results?.length !== 1)
		throw new ApiFail(
			409,
			'conflict',
			'Schedule permission changed; refresh and make a fresh choice',
			{ committed: false }
		);
	return readScheduleConsent(db, actor.userId, scheduleId);
}
