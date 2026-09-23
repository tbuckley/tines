import { sql, type CompiledQuery, type Kysely, type RawBuilder } from 'kysely';
import type { Database } from '../db';

/** One parameterized fence for both candidate selection and key delivery. */
export function ownerIssueConsentPredicate(
	userId: string,
	issueAlias = 'issue',
	projectAlias = 'project'
): RawBuilder<boolean> {
	const issueId = sql.ref(`${issueAlias}.id`);
	const issueEpoch = sql.ref(`${issueAlias}.consent_epoch`);
	const issueHold = sql.ref(`${issueAlias}.agent_hold`);
	const projectOwner = sql.ref(`${projectAlias}.user_id`);
	const sharedAt = sql.ref(`${projectAlias}.shared_at`);
	return sql<boolean>`(
		${issueHold} = 0 AND (${sharedAt} IS NULL OR (
			${projectOwner} = ${userId}
			AND EXISTS (
				SELECT 1 FROM issue_personal_choice AS ipc
				WHERE ipc.issue_id = ${issueId} AND ipc.user_id = ${projectOwner}
					AND ipc.value = 'on' AND ipc.issue_epoch = ${issueEpoch}
					AND (ipc.source_kind = 'explicit_issue' OR (
						ipc.source_kind = 'schedule'
						AND EXISTS (
							SELECT 1 FROM scheduled_task s
							JOIN schedule_personal_choice sc ON sc.schedule_id = s.id
							WHERE s.id = ipc.source_schedule_id
								AND s.project_id = ${sql.ref(`${projectAlias}.id`)}
								AND s.permission_epoch = ipc.source_permission_epoch
								AND sc.user_id = ipc.user_id AND sc.value = 'on'
								AND sc.revision = ipc.source_grant_revision
								AND sc.permission_epoch = s.permission_epoch
								AND sc.membership_revision = ipc.membership_revision
						)
					))
			)
		))
	)`;
}

/** Assigned work is released by a status CAS; admitted work is never touched. */
export function releaseAssignedIssueQueries(
	db: Kysely<Database>,
	input: {
		issueId: string;
		userId: string;
		token: string;
		eventId: string;
		now: number;
		reason: string;
		guard: RawBuilder<boolean>;
	}
): CompiledQuery[] {
	return [
		sql`UPDATE agent_run SET status = 'canceled', outcome = NULL, ended_at = ${input.now},
			error = ${input.reason}, assignment_release_token = ${input.token}
		WHERE issue_id = ${input.issueId} AND user_id = ${input.userId} AND status = 'assigned'
			AND ${input.guard}`.compile(db),
		sql`UPDATE api_key SET revoked_at = ${input.now}
		WHERE revoked_at IS NULL AND agent_run_id IN (
			SELECT id FROM agent_run WHERE issue_id = ${input.issueId}
				AND assignment_release_token = ${input.token}
		)`.compile(db),
		sql`INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
		SELECT ${input.eventId}, ${input.userId}, 'agent_run.assignments_released', ${input.userId}, NULL,
			${input.issueId}, issue.project_id, ${JSON.stringify({ reason: input.reason })}, ${input.now}
		FROM issue WHERE issue.id = ${input.issueId}
			AND EXISTS (SELECT 1 FROM agent_run WHERE issue_id = ${input.issueId}
				AND assignment_release_token = ${input.token})`.compile(db)
	];
}
