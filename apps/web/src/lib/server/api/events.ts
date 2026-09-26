import type { Actor, ActorRun, TinesEvent } from '@tines/shared';
import { sql, type CompiledQuery, type Kysely, type RawBuilder } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { ApiFail, attributedUserId, type ActorContext } from './core';
import { sharedEventPayload } from './shared-events';

export interface EventWindowFilters {
	since?: number;
	until?: number;
	type?: string | string[];
	state?: string;
}

/** Apply the time/type/state predicates shared by activity and stage stats. */
export function applyEventWindow<Q>(query: Q, filters: EventWindowFilters): Q {
	// Kysely's table type differs for the display query and the slim analytics
	// query; both expose the same where builder for event columns.
	let q = query as Q & { where: (...args: unknown[]) => Q };
	if (filters.since !== undefined) q = q.where('event.created_at', '>=', filters.since) as typeof q;
	if (filters.until !== undefined) q = q.where('event.created_at', '<', filters.until) as typeof q;
	if (filters.type) {
		const types = Array.isArray(filters.type) ? filters.type : [filters.type];
		q = q.where('event.type', 'in', types) as typeof q;
	}
	if (filters.state) {
		const state = filters.state;
		q = q.where((eb: any) =>
			eb.or([
				eb(sql<string>`json_extract(event.payload, '$.from_state_id')`, '=', state),
				eb(sql<string>`json_extract(event.payload, '$.to_state_id')`, '=', state),
				eb(sql<string>`json_extract(event.payload, '$.state_id')`, '=', state)
			])
		) as typeof q;
	}
	return q as Q;
}
import type { QueryGuard } from './query-guard';
import { runStillBoundPredicate } from './project-access';

export interface EventInput {
	/** Stable batch allocation; ordinary callers omit these. */
	id?: string;
	createdAt?: number;
	type: string;
	issueId?: string | null;
	projectId?: string | null;
	payload?: Record<string, unknown>;
	/** Parameterized SQL producing the JSON payload; mutually exclusive with payload. */
	payloadSql?: RawBuilder<string>;
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
	guard?: EventGuard | QueryGuard
): CompiledQuery {
	const values = {
		id: input.id ?? newId('evt'),
		user_id: input.issueId
			? sql<string>`(SELECT p.user_id FROM issue i JOIN project p ON p.id = i.project_id WHERE i.id = ${input.issueId})`
			: input.projectId
				? sql<string>`(SELECT user_id FROM project WHERE id = ${input.projectId})`
				: sql<string>`${actor.userId}`,
		type: input.type,
		actor_user_id: attributedUserId(actor),
		actor_api_key_id: actor.apiKeyId,
		issue_id: input.issueId ?? null,
		payload: input.payloadSql ?? JSON.stringify(input.payload ?? {}),
		created_at: input.createdAt ?? Date.now()
	};
	// Issue-scoped attribution belongs to the issue's project at the instant the
	// event commits. Resolving it here avoids a read-before-transfer writer
	// recording a new event in the issue's former project.
	const projectId = input.issueId
		? sql<string | null>`(SELECT project_id FROM issue WHERE id = ${input.issueId})`
		: sql<string | null>`${input.projectId ?? null}`;
	const guarded =
		guard === undefined
			? null
			: 'predicate' in guard
				? guard.predicate
				: sql<boolean>`EXISTS (
			SELECT 1 FROM issue
			WHERE id = ${guard.issueId} AND state_id = ${guard.stateId} AND updated_at = ${guard.updatedAt}
		)`;
	// A run key's event commits only while its binding holds (Tines/751), so a
	// write refused by the run guard never leaves an event behind.
	const predicate = actor.runRestriction
		? guarded
			? sql<boolean>`${guarded} AND ${runStillBoundPredicate(actor)}`
			: runStillBoundPredicate(actor)
		: guarded;
	if (!predicate)
		return sql`
			INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
			VALUES (${values.id}, ${values.user_id}, ${values.type}, ${values.actor_user_id}, ${values.actor_api_key_id},
				${values.issue_id}, ${projectId}, ${values.payload}, ${values.created_at})`.compile(db);
	return sql`
		INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
		SELECT ${values.id}, ${values.user_id}, ${values.type}, ${values.actor_user_id}, ${values.actor_api_key_id},
			${values.issue_id}, ${projectId}, ${values.payload}, ${values.created_at}
		WHERE ${predicate}`.compile(db);
}

/**
 * Resolve a run key's provenance from a row that joined `agent_run` → `runner`
 * → the run's issue and project. Shared by the event feed's actor and the API
 * keys listing, so both fall back the same way when a name is missing.
 */
export function actorRunOf(row: {
	run_id: string;
	runner_name: string | null;
	run_workflow_name?: string | null;
	run_state_name?: string | null;
	run_project_name: string | null;
	run_issue_number: number | null;
}): ActorRun {
	return {
		run_id: row.run_id,
		runner_name: row.runner_name ?? 'unknown runner',
		stage:
			row.run_workflow_name && row.run_state_name
				? { workflow_name: row.run_workflow_name, state_name: row.run_state_name }
				: null,
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
	actor_run_workflow_name?: string | null;
	actor_run_state_name?: string | null;
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
			run_workflow_name: row.actor_run_workflow_name ?? null,
			run_state_name: row.actor_run_state_name ?? null,
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
			.leftJoin('issue as peer_issue', (join) =>
				join.on('peer_issue.id', '=', sql<string>`json_extract(event.payload, '$.other_issue_id')`)
			)
			// Event project is immutable historical attribution. The issue ref is
			// independently canonical and follows the issue's current identity.
			.leftJoin('project as event_project', 'event_project.id', 'event.project_id')
			.leftJoin('project as issue_project', 'issue_project.id', 'issue.project_id')
			.select([
				'event.id',
				'event.type',
				'event.issue_id',
				'event.project_id',
				'event.payload',
				'event.created_at',
				'event.user_id as stream_user_id',
				'event.actor_user_id',
				'actor_user.name as actor_user_name',
				'event.actor_api_key_id',
				'api_key.name as actor_api_key_name',
				'actor_run.id as actor_run_id',
				'actor_runner.name as actor_runner_name',
				'api_key.run_workflow_name as actor_run_workflow_name',
				'api_key.run_state_name as actor_run_state_name',
				'actor_run_project.name as actor_run_project_name',
				'actor_run_issue.number as actor_run_issue_number',
				'issue.number as issue_number',
				'issue.title as issue_title',
				'event_project.name as project_name',
				'issue_project.name as issue_project_name',
				'issue_project.id as issue_project_id',
				'peer_issue.project_id as other_project_id'
			])
			.where('event.user_id', '=', userId)
	);
}

type EventRow = Awaited<ReturnType<ReturnType<typeof eventQuery>['execute']>>[number];

/**
 * A run event in the owner's stream whose run belongs to another contributor
 * (a member's run on a shared project, Tines/751). The owner sees its status
 * and outcome, never the contributor's usage, cost, error or provider detail.
 */
function isForeignRunEvent(row: EventRow): boolean {
	return (
		row.actor_user_id !== row.stream_user_id &&
		(row.type.startsWith('agent_run.') ||
			row.type.startsWith('runner.') ||
			row.type === 'issue.parked')
	);
}

export function serializeEvent(row: EventRow): TinesEvent {
	let payload: Record<string, unknown> = {};
	if (isForeignRunEvent(row)) {
		payload = sharedEventPayload(row.type, row.payload);
	} else {
		try {
			payload = JSON.parse(row.payload) as Record<string, unknown>;
		} catch {
			// Leave the payload empty if it somehow isn't valid JSON.
		}
	}
	if (row.other_project_id && typeof payload.other_issue_id === 'string')
		payload.other_project_id = row.other_project_id;
	return {
		id: row.id,
		type: row.type,
		actor: actorOf(row),
		issue_id: row.issue_id,
		project_id: row.project_id,
		issue_ref:
			row.issue_id && row.issue_number !== null && row.issue_project_name && row.issue_project_id
				? {
						project_id: row.issue_project_id,
						project_name: row.issue_project_name,
						number: row.issue_number,
						title: row.issue_title ?? ''
					}
				: null,
		project_name: row.project_name,
		payload,
		created_at: row.created_at
	};
}

export function eventTimeParam(
	params: URLSearchParams,
	name: 'since' | 'until'
): number | undefined {
	const value = params.get(name);
	if (!value) return undefined;
	const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
	if (!Number.isFinite(parsed))
		throw new ApiFail(422, 'validation_error', `"${name}" must be epoch milliseconds or ISO 8601`, {
			field: name
		});
	return parsed;
}
