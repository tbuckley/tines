import type { Actor, ActorRun, TinesEvent } from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import type { ActorContext } from './core';

export interface EventInput {
	type: string;
	issueId?: string | null;
	projectId?: string | null;
	payload?: Record<string, unknown>;
}

/**
 * When set, the event is only inserted if the issue row matches — used to
 * tie an event to a guarded (compare-and-swap) write in the same batch, so
 * a write that lost a race doesn't still record its event.
 */
export interface EventGuard {
	issueId: string;
	stateId: string;
	updatedAt: number;
}

/**
 * Compiled `event` insert, to be committed in the same D1 batch as the
 * mutation it describes.
 */
export function eventInsert(
	db: Kysely<Database>,
	actor: ActorContext,
	input: EventInput,
	guard?: EventGuard
): CompiledQuery {
	const values = {
		id: newId('evt'),
		user_id: actor.userId,
		type: input.type,
		actor_user_id: actor.userId,
		actor_api_key_id: actor.apiKeyId,
		issue_id: input.issueId ?? null,
		project_id: input.projectId ?? null,
		payload: JSON.stringify(input.payload ?? {}),
		created_at: Date.now()
	};
	if (!guard) return db.insertInto('event').values(values).compile();
	return sql`
		INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
		SELECT ${values.id}, ${values.user_id}, ${values.type}, ${values.actor_user_id}, ${values.actor_api_key_id},
			${values.issue_id}, ${values.project_id}, ${values.payload}, ${values.created_at}
		WHERE EXISTS (
			SELECT 1 FROM issue
			WHERE id = ${guard.issueId} AND state_id = ${guard.stateId} AND updated_at = ${guard.updatedAt}
		)`.compile(db);
}

/**
 * Resolve a run key's provenance from a row that joined `agent_run` → `runner`
 * → the run's issue and project. Shared by the event feed's actor and the API
 * keys listing, so both fall back the same way when a name is missing.
 */
export function actorRunOf(row: {
	run_id: string;
	runner_name: string | null;
	run_project_name: string | null;
	run_issue_number: number | null;
}): ActorRun {
	return {
		run_id: row.run_id,
		runner_name: row.runner_name ?? 'unknown runner',
		issue_ref:
			row.run_project_name && row.run_issue_number != null
				? { project_name: row.run_project_name, number: row.run_issue_number }
				: null
	};
}

export function actorOf(row: {
	actor_user_id: string;
	actor_user_name: string | null;
	actor_api_key_id: string | null;
	actor_api_key_name: string | null;
	/** Run-key provenance (resolved through agent_run to the runner). */
	actor_run_id?: string | null;
	actor_runner_name?: string | null;
	actor_run_project_name?: string | null;
	actor_run_issue_number?: number | null;
}): Actor {
	const actor: Actor = {
		user_id: row.actor_user_id,
		user_name: row.actor_user_name ?? 'unknown',
		api_key_id: row.actor_api_key_id,
		api_key_name: row.actor_api_key_id ? (row.actor_api_key_name ?? 'unknown key') : null
	};
	if (row.actor_run_id) {
		actor.run = actorRunOf({
			run_id: row.actor_run_id,
			runner_name: row.actor_runner_name ?? null,
			run_project_name: row.actor_run_project_name ?? null,
			run_issue_number: row.actor_run_issue_number ?? null
		});
	}
	return actor;
}

/** Base query for the event feed with everything needed for display. */
export function eventQuery(db: Kysely<Database>, userId: string) {
	return (
		db
			.selectFrom('event')
			.innerJoin('user as actor_user', 'actor_user.id', 'event.actor_user_id')
			.leftJoin('api_key', 'api_key.id', 'event.actor_api_key_id')
			// Run-key attribution: resolve through the run to the runner and the
			// run's issue for "via <runner> · run on <project>/<number>" rendering.
			.leftJoin('agent_run as actor_run', 'actor_run.id', 'api_key.agent_run_id')
			.leftJoin('runner as actor_runner', 'actor_runner.id', 'actor_run.runner_id')
			.leftJoin('issue as actor_run_issue', 'actor_run_issue.id', 'actor_run.issue_id')
			.leftJoin(
				'project as actor_run_project',
				'actor_run_project.id',
				'actor_run_issue.project_id'
			)
			.leftJoin('issue', 'issue.id', 'event.issue_id')
			.leftJoin('project', 'project.id', 'event.project_id')
			.select([
				'event.id',
				'event.type',
				'event.issue_id',
				'event.project_id',
				'event.payload',
				'event.created_at',
				'event.actor_user_id',
				'actor_user.name as actor_user_name',
				'event.actor_api_key_id',
				'api_key.name as actor_api_key_name',
				'actor_run.id as actor_run_id',
				'actor_runner.name as actor_runner_name',
				'actor_run_project.name as actor_run_project_name',
				'actor_run_issue.number as actor_run_issue_number',
				'issue.number as issue_number',
				'issue.title as issue_title',
				'project.name as project_name'
			])
			.where('event.user_id', '=', userId)
	);
}

type EventRow = Awaited<ReturnType<ReturnType<typeof eventQuery>['execute']>>[number];

export function serializeEvent(row: EventRow): TinesEvent {
	let payload: Record<string, unknown> = {};
	try {
		payload = JSON.parse(row.payload) as Record<string, unknown>;
	} catch {
		// Leave the payload empty if it somehow isn't valid JSON.
	}
	return {
		id: row.id,
		type: row.type,
		actor: actorOf(row),
		issue_id: row.issue_id,
		project_id: row.project_id,
		issue_ref:
			row.issue_id && row.issue_number !== null && row.project_name
				? {
						project_name: row.project_name,
						number: row.issue_number,
						title: row.issue_title ?? ''
					}
				: null,
		project_name: row.project_name,
		payload,
		created_at: row.created_at
	};
}
