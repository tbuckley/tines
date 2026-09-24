import type { IssueConsentReceipt, IssueConsentRequest } from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { ApiFail, notFound, runAtomic, type ActorContext } from './core';
import { eventInsert } from './events';
import type { QueryGuard } from './query-guard';
import { releaseAssignedIssueQueries } from '../supervisor/consent-admission';
import { memberStillCurrentPredicate } from './project-access';

const CONSENT_FIELDS = [
	'allow_my_agents',
	'allow_my_agents_future',
	'initial_allow_my_agents',
	'future_allow_my_agents',
	'allow_my_agents_on_future_instances',
	'my_agents',
	'personal_consent',
	'disclosure_version',
	'expected_consent_revision',
	'expected_consent_epoch',
	'expected_decision_revision',
	'issue_epoch'
] as const;
const CONSENT_MUTATIONS = [
	'allow_my_agents',
	'allow_my_agents_future',
	'initial_allow_my_agents',
	'future_allow_my_agents',
	'allow_my_agents_on_future_instances',
	'my_agents',
	'personal_consent',
	'disclosure_version'
] as const;

function consentFields(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(consentFields);
	if (typeof value !== 'object' || value === null) return [];
	return Object.entries(value).flatMap(([field, child]) => [
		...((CONSENT_FIELDS as readonly string[]).includes(field) ? [field] : []),
		...consentFields(child)
	]);
}

/** Reject choice-shaped input before a caller can reach a domain write. */
export function rejectKeyConsentInput(actor: ActorContext, body: object): void {
	if (actor.viaSession && !actor.bearerPresent) return;
	if (
		consentFields(body).some((field) => (CONSENT_MUTATIONS as readonly string[]).includes(field))
	) {
		throw new ApiFail(
			403,
			'consent_browser_required',
			'Personal permission can only be changed in an authenticated browser session; open the issue in Tines to choose.'
		);
	}
}

/** The personal-permission notice text the browser currently shows. */
export const PERSONAL_DISCLOSURE_VERSION = 1;

/**
 * Records that the signed-in person read the personal-permission notice, so
 * later forms show it collapsed. It grants nothing: permission is still chosen
 * per issue or schedule. Browser-only, like every other consent write.
 */
export async function acknowledgeDisclosure(
	db: Kysely<Database>,
	actor: ActorContext,
	body: { version?: unknown }
): Promise<{ version: number }> {
	if (!actor.viaSession || actor.bearerPresent) {
		throw new ApiFail(
			403,
			'consent_browser_required',
			'The personal permission notice can only be acknowledged in an authenticated browser session.'
		);
	}
	if (body.version !== PERSONAL_DISCLOSURE_VERSION) {
		throw new ApiFail(
			422,
			'invalid_field',
			`"version" must be ${PERSONAL_DISCLOSURE_VERSION}, the notice this release shows`,
			{ field: 'version' }
		);
	}
	await db
		.insertInto('personal_disclosure')
		.values({ user_id: actor.userId, version: body.version, acknowledged_at: Date.now() })
		.onConflict((oc) => oc.columns(['user_id', 'version']).doNothing())
		.execute();
	return { version: body.version };
}

/** Reject choice fields that are not part of this endpoint's request contract. */
export function assertConsentFieldsSupported(
	actor: ActorContext,
	body: object,
	allowedFields: readonly string[] = []
): void {
	const fields = consentFields(body);
	rejectKeyConsentInput(actor, body);
	const unsupported = [...new Set(fields)].filter((field) => !allowedFields.includes(field));
	if (unsupported.length > 0) {
		throw new ApiFail(
			422,
			'invalid_field',
			`Unsupported personal permission field: ${unsupported[0]}`,
			{
				field: unsupported[0]
			}
		);
	}
}

export function createProjectWriteGuard(
	actor: ActorContext,
	projectId: string,
	sharingRevision: number
): QueryGuard {
	return {
		predicate: sql<boolean>`EXISTS (
			SELECT 1 FROM project
			WHERE id = ${projectId} AND user_id = ${actor.userId}
				AND archived_at IS NULL AND sharing_revision = ${sharingRevision}
		) AND ${memberStillCurrentPredicate(actor)}`
	};
}

export async function readIssueConsent(
	db: Kysely<Database>,
	userId: string,
	issueId: string
): Promise<IssueConsentReceipt> {
	const row = await db
		.selectFrom('issue as i')
		.innerJoin('project as p', 'p.id', 'i.project_id')
		.innerJoin('workflow as w', 'w.id', 'i.workflow_id')
		.innerJoin('workflow_state as s', 's.id', 'i.state_id')
		.leftJoin('issue_personal_choice as c', (join) =>
			join.onRef('c.issue_id', '=', 'i.id').on('c.user_id', '=', userId)
		)
		.leftJoin('project_member as m', (join) =>
			join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', userId)
		)
		.select([
			'i.id as issue_id',
			'i.project_id',
			'i.consent_epoch',
			'i.decision_revision',
			'w.decision_revision as workflow_revision',
			'i.agent_hold',
			'i.needs_attention',
			'i.hold_revision',
			's.id as state_id',
			's.category as state_category',
			'p.user_id as owner_id',
			'p.shared_at',
			'p.archived_at',
			'p.sharing_revision',
			'c.value as choice_value',
			'c.revision as choice_revision',
			'c.issue_epoch as choice_epoch',
			'c.source_kind',
			'c.membership_revision as choice_membership_revision',
			'm.revision as member_revision'
		])
		.where('i.id', '=', issueId)
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
			'Personal permission is available after project sharing begins'
		);
	const admitted = await db
		.selectFrom('agent_run')
		.select('id')
		.where('issue_id', '=', issueId)
		.where('status', 'in', ['launching', 'running'])
		.where('admitted_at', 'is not', null)
		.orderBy('created_at desc')
		.executeTakeFirst();
	return {
		actor: row.owner_id === userId ? 'owner' : 'member',
		project: { id: row.project_id, sharing_revision: row.sharing_revision },
		issue_state: {
			id: row.state_id,
			category: row.state_category,
			decision_revision: row.decision_revision,
			workflow_revision: row.workflow_revision
		},
		agent_hold: { held: Boolean(row.agent_hold), revision: row.hold_revision },
		my_agents: {
			value:
				row.choice_epoch === row.consent_epoch &&
				row.choice_membership_revision === (row.owner_id === userId ? 0 : row.member_revision)
					? (row.choice_value ?? 'unset')
					: 'unset',
			source: row.choice_epoch === row.consent_epoch ? (row.source_kind ?? null) : null,
			revision: row.choice_revision ?? 0,
			epoch: row.consent_epoch
		},
		readiness:
			row.owner_id !== userId
				? 'unavailable'
				: row.agent_hold
					? 'held'
					: row.state_category === 'active' &&
						  // The owner's unset is on (ownerIssueConsentPredicate).
						  !(row.choice_value === 'off' && row.choice_epoch === row.consent_epoch) &&
						  !row.needs_attention &&
						  row.archived_at === null
						? 'eligible'
						: 'unavailable',
		admitted_run: row.owner_id === userId ? (admitted?.id ?? null) : null,
		...(row.owner_id === userId
			? {}
			: {
					message:
						'Permission saved. Member execution is not available in this release; only the owner’s approved agents can run.'
				}),
		committed_atomically: true
	};
}

/** Display-only roster. Owner is always first; another person's choice is never writable here. */
export async function listIssuePermissionRoster(db: Kysely<Database>, issueId: string) {
	const issue = await db
		.selectFrom('issue as i')
		.innerJoin('project as p', 'p.id', 'i.project_id')
		.innerJoin('user as owner', 'owner.id', 'p.user_id')
		.leftJoin('issue_personal_choice as c', (join) =>
			join.onRef('c.issue_id', '=', 'i.id').onRef('c.user_id', '=', 'owner.id')
		)
		.select([
			'i.project_id',
			'i.consent_epoch',
			'owner.id as owner_id',
			'owner.name as owner_name',
			'c.value as owner_value',
			'c.issue_epoch as owner_epoch'
		])
		.where('i.id', '=', issueId)
		.executeTakeFirstOrThrow();
	const members = await db
		.selectFrom('project_member as m')
		.innerJoin('user as u', 'u.id', 'm.user_id')
		.leftJoin('issue_personal_choice as c', (join) =>
			join.on('c.issue_id', '=', issueId).onRef('c.user_id', '=', 'm.user_id')
		)
		.select(['u.id', 'u.name', 'm.revision', 'c.value', 'c.issue_epoch', 'c.membership_revision'])
		.where('m.project_id', '=', issue.project_id)
		.where('m.revoked_at', 'is', null)
		.orderBy('u.name')
		.orderBy('u.id')
		.execute();
	return [
		{
			user: { id: issue.owner_id, name: issue.owner_name },
			role: 'owner' as const,
			value: issue.owner_epoch === issue.consent_epoch ? (issue.owner_value ?? 'unset') : 'unset'
		},
		...members.map((person) => ({
			user: { id: person.id, name: person.name },
			role: 'member' as const,
			value:
				person.issue_epoch === issue.consent_epoch && person.membership_revision === person.revision
					? (person.value ?? 'unset')
					: 'unset'
		}))
	];
}

/**
 * Revisioned owner choice. The selected issue epoch and decision revision are
 * checked by the INSERT..SELECT, so a stale intent cannot recreate a grant
 * after a lifecycle reset.
 */
export async function writeIssueConsent(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	body: IssueConsentRequest,
	beforeCommit?: () => Promise<void>
): Promise<IssueConsentReceipt> {
	for (const field of ['user_id', 'subject_user_id', 'creator_user_id', 'actor_user_id']) {
		if (field in body)
			throw new ApiFail(
				422,
				'invalid_field',
				'Personal permission always belongs to the signed-in person',
				{ field }
			);
	}
	if (!actor.viaSession || actor.bearerPresent) {
		throw new ApiFail(
			403,
			'consent_browser_required',
			'Personal permission can only be changed in an authenticated browser session; open the issue in Tines to choose.'
		);
	}
	if (body.value !== 'on' && body.value !== 'off') {
		throw new ApiFail(422, 'invalid_field', '"value" must be "on" or "off"', { field: 'value' });
	}
	if (
		body.disclosure_version !== undefined &&
		(!Number.isInteger(body.disclosure_version) || body.disclosure_version < 1)
	) {
		throw new ApiFail(422, 'invalid_field', '"disclosure_version" must be a positive integer', {
			field: 'disclosure_version'
		});
	}
	for (const [field, value] of [
		['expected_revision', body.expected_revision],
		['issue_epoch', body.issue_epoch],
		['decision_revision', body.decision_revision]
	] as const) {
		if (!Number.isInteger(value) || value < 0) {
			throw new ApiFail(422, 'invalid_field', `"${field}" must be a non-negative integer`, {
				field
			});
		}
	}
	const current = await db
		.selectFrom('issue as i')
		.innerJoin('project as p', 'p.id', 'i.project_id')
		.innerJoin('workflow_state as s', 's.id', 'i.state_id')
		.leftJoin('issue_personal_choice as c', (join) =>
			join.onRef('c.issue_id', '=', 'i.id').on('c.user_id', '=', actor.userId)
		)
		.leftJoin('project_member as m', (join) =>
			join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', actor.userId)
		)
		.select([
			'i.project_id',
			'i.consent_epoch',
			'i.decision_revision',
			'i.agent_hold',
			's.id as state_id',
			's.category',
			'p.shared_at',
			'p.sharing_revision',
			'c.revision as choice_revision',
			'p.user_id as owner_id',
			'm.revision as member_revision'
		])
		.where('i.id', '=', issueId)
		.where((eb) =>
			eb.or([
				eb('p.user_id', '=', actor.userId),
				eb.and([
					eb('p.shared_at', 'is not', null),
					eb('m.revision', 'is not', null),
					eb('m.revoked_at', 'is', null)
				])
			])
		)
		.executeTakeFirst();
	if (!current) throw notFound();
	if (current.shared_at === null)
		throw new ApiFail(
			409,
			'consent_mode_required',
			'Personal permission is available after project sharing begins'
		);
	if (current.category === 'done') {
		throw new ApiFail(422, 'issue_terminal', 'A done issue has no personal permission control');
	}
	const revision = current.choice_revision ?? 0;
	if (
		revision !== body.expected_revision ||
		current.consent_epoch !== body.issue_epoch ||
		current.decision_revision !== body.decision_revision
	) {
		throw new ApiFail(
			409,
			'conflict',
			'Permission or issue changed; refresh and make a fresh choice',
			{
				committed: false,
				current_revision: revision,
				current_epoch: current.consent_epoch,
				current_decision_revision: current.decision_revision
			}
		);
	}
	const now = Date.now();
	const token = newId('dcn');
	// Off releases assigned work before it is delivered. An owner's on does too:
	// work claimed while the owner's choice was unset (which admits the owner)
	// carries the old choice revision, so it could never pass the delivery
	// guard and would sit assigned until the stall sweep. Released, it is simply
	// claimed again under the new revision.
	const releaseQueries =
		body.value === 'off' || current.owner_id === actor.userId
			? releaseAssignedIssueQueries(db, {
					issueId,
					userId: actor.userId,
					token,
					eventId: newId('evt'),
					now,
					reason:
						body.value === 'off'
							? 'Issue permission was turned off before admission'
							: 'Issue permission changed before admission; the issue is dispatched again',
					guard: sql<boolean>`EXISTS (SELECT 1 FROM issue_personal_choice
					WHERE issue_id = ${issueId} AND user_id = ${actor.userId}
						AND last_request_token = ${token} AND value = ${body.value})`
				})
			: [];
	await beforeCommit?.();
	const results = await runAtomic(env, [
		sql`
			INSERT INTO issue_personal_choice
				(issue_id, user_id, value, revision, issue_epoch, membership_revision,
				 source_kind, updated_at, last_request_token)
			SELECT ${issueId}, ${actor.userId}, ${body.value}, ${revision + 1},
				i.consent_epoch, ${current.owner_id === actor.userId ? 0 : current.member_revision}, 'explicit_issue', ${now}, ${token}
			FROM issue AS i JOIN project AS p ON p.id = i.project_id
			JOIN workflow_state AS s ON s.id = i.state_id
			WHERE i.id = ${issueId} AND p.shared_at IS NOT NULL
				AND ${
					current.owner_id === actor.userId
						? sql<boolean>`p.user_id = ${actor.userId}`
						: sql<boolean>`EXISTS (SELECT 1 FROM project_member m WHERE m.project_id = p.id
						AND m.user_id = ${actor.userId} AND m.revision = ${current.member_revision}
						AND m.revoked_at IS NULL)`
				}
				AND i.consent_epoch = ${body.issue_epoch}
				AND i.decision_revision = ${body.decision_revision} AND s.category != 'done'
			ON CONFLICT(issue_id, user_id) DO UPDATE SET
				value = excluded.value,
				revision = issue_personal_choice.revision + 1,
				issue_epoch = excluded.issue_epoch,
				membership_revision = excluded.membership_revision,
				source_kind = 'explicit_issue', source_schedule_id = NULL,
				source_grant_revision = NULL, source_permission_epoch = NULL,
				updated_at = excluded.updated_at, last_request_token = excluded.last_request_token
			WHERE issue_personal_choice.revision = ${revision}
		`.compile(db),
		...(body.disclosure_version && Number.isInteger(body.disclosure_version)
			? [
					sql`INSERT INTO personal_disclosure (user_id, version, acknowledged_at)
					SELECT ${actor.userId}, ${body.disclosure_version}, ${now}
					WHERE EXISTS (SELECT 1 FROM issue_personal_choice
						WHERE issue_id = ${issueId} AND user_id = ${actor.userId}
							AND last_request_token = ${token})
					ON CONFLICT(user_id, version) DO NOTHING`.compile(db)
				]
			: []),
		...releaseQueries,
		eventInsert(
			db,
			actor,
			{
				type: 'issue.personal_permission_changed',
				issueId,
				projectId: current.project_id,
				payload: { value: body.value, revision: revision + 1 }
			},
			{
				predicate: sql<boolean>`EXISTS (
				SELECT 1 FROM issue_personal_choice
				WHERE issue_id = ${issueId} AND user_id = ${actor.userId}
					AND last_request_token = ${token}
			)`
			}
		)
	]);
	if ((results[0]?.meta.changes ?? 0) !== 1) {
		throw new ApiFail(409, 'conflict', 'Permission changed; refresh and make a fresh choice', {
			committed: false
		});
	}
	return readIssueConsent(db, actor.userId, issueId);
}
