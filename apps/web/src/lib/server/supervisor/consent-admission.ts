import { sql, type CompiledQuery, type Kysely, type RawBuilder } from 'kysely';
import type { Database } from '../db';

/**
 * One parameterized fence for both candidate selection and key delivery.
 *
 * In a shared project only the owner's agents are admitted, and the owner's
 * permission defaults on (decision 2026-09-24,
 * specs/projects/SHARING_OWNER_DEFAULT_2026-09-24.md): an owner with no
 * current choice (no row, or one from an earlier issue epoch) is admitted, as
 * in a project that was never shared. Only an explicit `off` at the issue's
 * current epoch, set on the issue or inherited from a schedule whose future
 * permission the owner turned off, keeps the owner's agents away. Members
 * stay opt-in and are never admitted in this release.
 */
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
			AND NOT EXISTS (
				SELECT 1 FROM issue_personal_choice AS ipc
				WHERE ipc.issue_id = ${issueId} AND ipc.user_id = ${projectOwner}
					AND ipc.value = 'off' AND ipc.issue_epoch = ${issueEpoch}
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
		SELECT ${input.eventId}, project.user_id, 'agent_run.assignments_released', ${input.userId}, NULL,
			${input.issueId}, issue.project_id, ${JSON.stringify({ reason: input.reason })}, ${input.now}
		FROM issue JOIN project ON project.id = issue.project_id WHERE issue.id = ${input.issueId}
			AND EXISTS (SELECT 1 FROM agent_run WHERE issue_id = ${input.issueId}
				AND assignment_release_token = ${input.token})`.compile(db)
	];
}
