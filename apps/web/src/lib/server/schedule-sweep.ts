/**
 * Scheduled-task execution shared by cron and Run now.
 *
 * All eligibility, gate, issue/event writes, and schedule bookkeeping are
 * submitted in one D1 batch. The final receipt is part of that batch so a
 * caller never decides from a preflight read or a statement change count.
 */
import { nextOccurrenceFromCron, renderTemplate, templateVars } from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { getDb, newId, type Database } from './db';
import { nextIssueNumber } from './issue-address';

export interface ScheduleExecRow {
	id: string;
	project_id: string;
	name: string;
	title_template: string;
	description_template: string;
	workflow_id: string;
	state_id: string | null;
	cron: string;
	timezone: string;
	require_all_closed: number;
	enabled: number;
	next_run_at: number;
	run_count: number;
	definition_revision: number;
	user_id: string;
	start_state_id: string;
	start_state_name: string;
	start_state_category: string;
	project_name: string;
	project_archived_at: number | null;
}

export function scheduleExecQuery(db: Kysely<Database>) {
	return db
		.selectFrom('scheduled_task')
		.innerJoin('project', 'project.id', 'scheduled_task.project_id')
		.innerJoin('workflow', 'workflow.id', 'scheduled_task.workflow_id')
		.innerJoin('workflow_state as start_state', (join) =>
			join
				.on((eb) =>
					eb(
						'start_state.id',
						'=',
						eb.fn.coalesce('scheduled_task.state_id', 'workflow.initial_state_id')
					)
				)
				.onRef('start_state.workflow_id', '=', 'workflow.id')
		)
		.select([
			'scheduled_task.id',
			'scheduled_task.project_id',
			'scheduled_task.name',
			'scheduled_task.title_template',
			'scheduled_task.description_template',
			'scheduled_task.workflow_id',
			'scheduled_task.state_id',
			'scheduled_task.cron',
			'scheduled_task.timezone',
			'scheduled_task.require_all_closed',
			'scheduled_task.enabled',
			'scheduled_task.next_run_at',
			'scheduled_task.run_count',
			'scheduled_task.definition_revision',
			'project.user_id as user_id',
			'project.name as project_name',
			'project.archived_at as project_archived_at',
			'start_state.id as start_state_id',
			'start_state.name as start_state_name',
			'start_state.category as start_state_category'
		]);
}

export function openInstancesQuery(db: Kysely<Database>, scheduleId: string) {
	return db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.innerJoin('workflow_state as state', 'state.id', 'issue.state_id')
		.select([
			'issue.id',
			'issue.number',
			'issue.title',
			'issue.project_id',
			'project.name as project_name'
		])
		.where('issue.scheduled_task_id', '=', scheduleId)
		.where('state.category', '!=', 'done')
		.orderBy('issue.number asc')
		.orderBy('issue.id asc');
}

export type ExecutionMode =
	| { kind: 'manual'; actor: { userId: string; apiKeyId: string | null } }
	| { kind: 'cron'; due: number; advanceTo: number };

export type ExecutionStatus =
	| 'created'
	| 'skipped'
	| 'not_found'
	| 'archived'
	| 'blocked'
	| 'definition_changed'
	| 'start_changed'
	| 'count_changed'
	| 'ineligible';

export interface ExecutionReceipt {
	status: ExecutionStatus;
	issue_id: string;
	created_event_id: string;
	skipped_event_id: string | null;
	archived_at: number | null;
	blocking: Array<{
		issue_id: string;
		project_id: string;
		project_name: string;
		number: number;
		title: string;
	}>;
}

function executionPredicates(schedule: ScheduleExecRow, mode: ExecutionMode, now: number) {
	const cron = mode.kind === 'cron';
	return {
		eligible: sql`EXISTS (
			SELECT 1 FROM scheduled_task s
			JOIN project p ON p.id = s.project_id
			JOIN workflow w ON w.id = s.workflow_id
			JOIN workflow_state st ON st.id = COALESCE(s.state_id, w.initial_state_id)
			WHERE s.id = ${schedule.id}
			  AND s.definition_revision = ${schedule.definition_revision}
			  AND s.project_id = ${schedule.project_id}
			  AND p.user_id = ${schedule.user_id}
			  AND p.archived_at IS NULL
			  AND s.workflow_id = ${schedule.workflow_id}
			  AND (s.state_id = ${schedule.state_id} OR (s.state_id IS NULL AND ${schedule.state_id} IS NULL))
			  AND COALESCE(s.state_id, w.initial_state_id) = ${schedule.start_state_id}
			  AND st.workflow_id = w.id
			  AND st.id = ${schedule.start_state_id}
			  AND st.name = ${schedule.start_state_name}
			  AND st.category = ${schedule.start_state_category}
			  ${cron ? sql`AND s.enabled = 1 AND s.next_run_at = ${mode.due} AND s.next_run_at <= ${now}` : sql``}
		)`,
		blocked: sql`EXISTS (
			SELECT 1 FROM scheduled_task gate
			WHERE gate.id = ${schedule.id} AND gate.require_all_closed = 1
			  AND EXISTS (
				SELECT 1 FROM issue i
				JOIN workflow_state bs ON bs.id = i.state_id
				WHERE i.scheduled_task_id = gate.id AND bs.category <> 'done'
			  )
		)`,
		countMatches: sql`EXISTS (
			SELECT 1 FROM scheduled_task s
			WHERE s.id = ${schedule.id} AND s.run_count = ${schedule.run_count}
		)`
	};
}

export function buildScheduleExecution(
	db: Kysely<Database>,
	schedule: ScheduleExecRow,
	opts: { now: number; mode: ExecutionMode }
): {
	issueId: string;
	createdEventId: string;
	skippedEventId: string | null;
	queries: CompiledQuery[];
	receiptIndex: number;
} {
	const issueId = newId('iss');
	const createdEventId = newId('evt');
	const skippedEventId = opts.mode.kind === 'cron' ? newId('evt') : null;
	const vars = templateVars(schedule.name, schedule.run_count + 1, schedule.timezone, opts.now);
	const title = renderTemplate(schedule.title_template, vars);
	const description = renderTemplate(schedule.description_template, vars);
	const predicates = executionPredicates(schedule, opts.mode, opts.now);
	const advance = opts.mode.kind === 'cron' ? opts.mode.advanceTo : null;
	const due = opts.mode.kind === 'cron' ? opts.mode.due : null;
	const actorUserId = opts.mode.kind === 'manual' ? opts.mode.actor.userId : schedule.user_id;
	const actorApiKeyId = opts.mode.kind === 'manual' ? opts.mode.actor.apiKeyId : null;

	const issueInsert = sql`
		INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, scheduled_task_id, created_at, updated_at)
		SELECT ${issueId}, ${schedule.project_id}, ${nextIssueNumber(schedule.project_id)},
			${title}, ${description}, ${schedule.workflow_id}, ${schedule.start_state_id}, ${schedule.id}, ${opts.now}, ${opts.now}
		WHERE ${predicates.eligible} AND NOT (${predicates.blocked}) AND ${predicates.countMatches}`.compile(
		db
	);

	const eventPayload =
		opts.mode.kind === 'manual'
			? sql`json_object('title', ${title}, 'workflow_id', ${schedule.workflow_id}, 'state_id', ${schedule.start_state_id}, 'state_name', ${schedule.start_state_name}, 'scheduled_task_id', ${schedule.id}, 'scheduled_task_name', ${schedule.name}, 'manual', json('true'))`
			: sql`json_object('title', ${title}, 'workflow_id', ${schedule.workflow_id}, 'state_id', ${schedule.start_state_id}, 'state_name', ${schedule.start_state_name}, 'scheduled_task_id', ${schedule.id}, 'scheduled_task_name', ${schedule.name})`;
	const createdEvent = sql`
		INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
		SELECT ${createdEventId}, ${schedule.user_id}, 'issue.created', ${actorUserId}, ${actorApiKeyId}, ${issueId}, ${schedule.project_id}, ${eventPayload}, ${opts.now}
		WHERE EXISTS (SELECT 1 FROM issue WHERE id = ${issueId})`.compile(db);

	const skipPayload = sql`json_object(
		'schedule_id', ${schedule.id}, 'name', ${schedule.name}, 'occurrence', ${due},
		'blocking', COALESCE((SELECT json_group_array(json_object('issue_id', b.id, 'project_id', b.project_id, 'project_name', b.project_name, 'number', b.number))
			FROM (SELECT i.id, i.project_id, p.name AS project_name, i.number, i.title
				FROM issue i JOIN project p ON p.id = i.project_id JOIN workflow_state bs ON bs.id = i.state_id
				WHERE i.scheduled_task_id = ${schedule.id} AND bs.category <> 'done'
				ORDER BY i.number ASC, i.id ASC) b), json('[]')))`;
	const skippedEvent = skippedEventId
		? sql`
			INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
			SELECT ${skippedEventId}, ${schedule.user_id}, 'scheduled_task.skipped', ${schedule.user_id}, NULL, NULL, ${schedule.project_id}, ${skipPayload}, ${opts.now}
			WHERE ${predicates.eligible} AND ${predicates.blocked} AND NOT EXISTS (SELECT 1 FROM issue WHERE id = ${issueId})`.compile(
				db
			)
		: null;

	const successUpdate = sql`
		UPDATE scheduled_task SET last_run_at = ${opts.now}, run_count = run_count + 1${advance === null ? sql`` : sql`, next_run_at = ${advance}`}
		WHERE id = ${schedule.id}
		  AND EXISTS (SELECT 1 FROM issue WHERE id = ${issueId})
		  AND EXISTS (SELECT 1 FROM event WHERE id = ${createdEventId})
		  AND ${predicates.eligible} AND ${predicates.countMatches}`.compile(db);
	const skipUpdate = skippedEventId
		? sql`
			UPDATE scheduled_task SET next_run_at = ${advance}
			WHERE id = ${schedule.id} AND EXISTS (SELECT 1 FROM event WHERE id = ${skippedEventId}) AND ${predicates.eligible}`.compile(
				db
			)
		: null;

	const blockingJson = sql<string>`COALESCE((SELECT json_group_array(json_object('issue_id', b.id, 'project_id', b.project_id, 'project_name', b.project_name, 'number', b.number, 'title', b.title))
		FROM (SELECT i.id, i.project_id, p.name AS project_name, i.number, i.title
			FROM issue i JOIN project p ON p.id = i.project_id JOIN workflow_state bs ON bs.id = i.state_id
			WHERE i.scheduled_task_id = ${schedule.id} AND bs.category <> 'done'
			ORDER BY i.number ASC, i.id ASC) b), json('[]'))`;
	const receipt = sql`
		SELECT CASE
			WHEN EXISTS (SELECT 1 FROM issue WHERE id = ${issueId}) AND EXISTS (SELECT 1 FROM event WHERE id = ${createdEventId}) THEN 'created'
			WHEN ${skippedEventId ? sql`EXISTS (SELECT 1 FROM event WHERE id = ${skippedEventId})` : sql`0`} THEN 'skipped'
			WHEN s.id IS NULL OR p.id IS NULL THEN 'not_found'
			WHEN p.archived_at IS NOT NULL THEN 'archived'
			WHEN s.require_all_closed = 1 AND ${predicates.blocked} THEN 'blocked'
			WHEN s.definition_revision <> ${schedule.definition_revision} THEN 'definition_changed'
			WHEN (s.state_id <> ${schedule.state_id} OR (s.state_id IS NULL AND ${schedule.state_id} IS NOT NULL) OR (s.state_id IS NOT NULL AND ${schedule.state_id} IS NULL)) OR COALESCE(s.state_id, w.initial_state_id) <> ${schedule.start_state_id} OR st.id IS NULL OR st.name <> ${schedule.start_state_name} OR st.category <> ${schedule.start_state_category} THEN 'start_changed'
			WHEN s.run_count <> ${schedule.run_count} THEN 'count_changed'
			${opts.mode.kind === 'cron' ? sql`WHEN s.enabled <> 1 OR s.next_run_at <> ${due} THEN 'ineligible'` : sql``}
			ELSE 'definition_changed' END AS status,
			${issueId} AS issue_id, ${createdEventId} AS created_event_id, ${skippedEventId} AS skipped_event_id, p.archived_at AS archived_at, ${blockingJson} AS blocking
		FROM scheduled_task s
		LEFT JOIN project p ON p.id = s.project_id
		LEFT JOIN workflow w ON w.id = s.workflow_id
		LEFT JOIN workflow_state st ON st.id = COALESCE(s.state_id, w.initial_state_id)
		WHERE s.id = ${schedule.id}
		UNION ALL SELECT 'not_found', ${issueId}, ${createdEventId}, ${skippedEventId}, NULL, json('[]')
		WHERE NOT EXISTS (SELECT 1 FROM scheduled_task WHERE id = ${schedule.id})`.compile(db);

	const queries = [
		issueInsert,
		createdEvent,
		...(skippedEvent ? [skippedEvent] : []),
		successUpdate,
		...(skipUpdate ? [skipUpdate] : []),
		receipt
	];
	return { issueId, createdEventId, skippedEventId, queries, receiptIndex: queries.length - 1 };
}

export function parseExecutionReceipt(
	result: { results?: unknown[] },
	expected: { issueId: string; createdEventId: string; skippedEventId: string | null }
): ExecutionReceipt {
	const row =
		result.results?.length === 1
			? (result.results[0] as Record<string, unknown> | undefined)
			: undefined;
	const statuses: ExecutionStatus[] = [
		'created',
		'skipped',
		'not_found',
		'archived',
		'blocked',
		'definition_changed',
		'start_changed',
		'count_changed',
		'ineligible'
	];
	if (
		!row ||
		typeof row.status !== 'string' ||
		!statuses.includes(row.status as ExecutionStatus) ||
		row.issue_id !== expected.issueId ||
		row.created_event_id !== expected.createdEventId ||
		row.skipped_event_id !== expected.skippedEventId
	)
		throw new Error('Malformed scheduled-task execution receipt');
	let blocking: ExecutionReceipt['blocking'];
	try {
		if (typeof row.blocking !== 'string') throw new Error('missing blocking');
		const value = JSON.parse(row.blocking);
		if (!Array.isArray(value)) throw new Error('not an array');
		if (
			value.some(
				(entry) =>
					typeof entry !== 'object' ||
					entry === null ||
					Array.isArray(entry) ||
					typeof (entry as Record<string, unknown>).issue_id !== 'string' ||
					typeof (entry as Record<string, unknown>).project_id !== 'string' ||
					typeof (entry as Record<string, unknown>).project_name !== 'string' ||
					!Number.isInteger((entry as Record<string, unknown>).number) ||
					typeof (entry as Record<string, unknown>).title !== 'string'
			)
		)
			throw new Error('invalid blocker');
		blocking = value as ExecutionReceipt['blocking'];
	} catch {
		throw new Error('Malformed scheduled-task blocker receipt');
	}
	if (!Object.prototype.hasOwnProperty.call(row, 'archived_at'))
		throw new Error('Malformed scheduled-task archive receipt');
	const archivedAt = row.archived_at == null ? null : row.archived_at;
	if (archivedAt !== null && (typeof archivedAt !== 'number' || !Number.isFinite(archivedAt)))
		throw new Error('Malformed scheduled-task archive receipt');
	return {
		status: row.status as ExecutionStatus,
		issue_id: expected.issueId,
		created_event_id: expected.createdEventId,
		skipped_event_id: expected.skippedEventId,
		archived_at: archivedAt,
		blocking
	};
}

async function runBatch(env: Env, queries: CompiledQuery[]) {
	return env.DB.batch(
		queries.map((q) => env.DB.prepare(q.sql).bind(...(q.parameters as unknown[])))
	);
}

async function runDueSchedule(
	db: Kysely<Database>,
	env: Env,
	schedule: ScheduleExecRow,
	now: number
): Promise<void> {
	const execution = buildScheduleExecution(db, schedule, {
		now,
		mode: {
			kind: 'cron',
			due: schedule.next_run_at,
			advanceTo: nextOccurrenceFromCron(schedule.cron, schedule.timezone, now)
		}
	});
	const results = await runBatch(env, execution.queries);
	const receipt = parseExecutionReceipt(results[execution.receiptIndex], execution);
	if (receipt.status === 'blocked')
		throw new Error('Cron execution returned blocked without a skip receipt');
}

export async function sweepSchedules(env: Env, now: number = Date.now()): Promise<void> {
	const db = getDb(env);
	const due = await scheduleExecQuery(db)
		.where('scheduled_task.enabled', '=', 1)
		.where('scheduled_task.next_run_at', '<=', now)
		.where('project.archived_at', 'is', null)
		.execute();
	for (const schedule of due) {
		try {
			await runDueSchedule(db, env, schedule, now);
		} catch (e) {
			console.error(`scheduled-task sweep: schedule ${schedule.id} (${schedule.name}) failed:`, e);
		}
	}
}
