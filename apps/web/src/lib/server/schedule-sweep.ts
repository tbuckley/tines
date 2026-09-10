/**
 * Scheduled-task execution: the Cron Trigger sweep and the shared
 * instance-creation statements it has in common with the run-now API.
 *
 * This module is imported by the custom worker entry (worker/index.ts), which
 * wrangler bundles outside the SvelteKit build — so it (and everything it
 * imports) sticks to relative/package imports: no `$lib`, no `@sveltejs/kit`.
 */
import { nextOccurrenceFromCron, renderTemplate, templateVars } from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { getDb, newId, type Database } from './db';
import { nextIssueNumber } from './issue-address';

/** Everything instance creation needs, joined once in the due query. */
export interface ScheduleExecRow {
	id: string;
	project_id: string;
	name: string;
	title_template: string;
	description_template: string;
	workflow_id: string;
	cron: string;
	timezone: string;
	require_all_closed: number;
	next_run_at: number;
	run_count: number;
	/** The owning user (project owner): issues and events are attributed to them. */
	user_id: string;
	/** The state instances start in: the schedule's pinned state, else the workflow's initial state. */
	start_state_id: string;
	start_state_name: string;
	/** Archived projects are skipped by the sweep and refuse run-now. */
	project_name: string;
	project_archived_at: number | null;
}

export function scheduleExecQuery(db: Kysely<Database>) {
	return db
		.selectFrom('scheduled_task')
		.innerJoin('project', 'project.id', 'scheduled_task.project_id')
		.innerJoin('workflow', 'workflow.id', 'scheduled_task.workflow_id')
		.innerJoin('workflow_state as start_state', (join) =>
			join.on((eb) =>
				eb(
					'start_state.id',
					'=',
					eb.fn.coalesce('scheduled_task.state_id', 'workflow.initial_state_id')
				)
			)
		)
		.select([
			'scheduled_task.id',
			'scheduled_task.project_id',
			'scheduled_task.name',
			'scheduled_task.title_template',
			'scheduled_task.description_template',
			'scheduled_task.workflow_id',
			'scheduled_task.cron',
			'scheduled_task.timezone',
			'scheduled_task.require_all_closed',
			'scheduled_task.next_run_at',
			'scheduled_task.run_count',
			'project.user_id as user_id',
			'project.name as project_name',
			'project.archived_at as project_archived_at',
			'start_state.id as start_state_id',
			'start_state.name as start_state_name'
		]);
}

/** Linked issues in a non-done state — the instances that block the gate. */
export function openInstancesQuery(db: Kysely<Database>, scheduleId: string) {
	return db
		.selectFrom('issue')
		.innerJoin('workflow_state as state', 'state.id', 'issue.state_id')
		.select(['issue.id', 'issue.number', 'issue.title'])
		.where('issue.scheduled_task_id', '=', scheduleId)
		.where('state.category', '!=', 'done')
		.orderBy('issue.number asc');
}

/**
 * Statements creating one instance of a schedule: the issue, its
 * issue.created event, and the schedule bookkeeping. When `guardDue` is set
 * (the sweep), the inserts only apply while next_run_at still equals it and
 * the bookkeeping update advances next_run_at — committed in one D1 batch,
 * that compare-and-swap is what makes overlapping sweeps harmless.
 */
export function instanceInserts(
	db: Kysely<Database>,
	schedule: ScheduleExecRow,
	opts: {
		now: number;
		manual: boolean;
		guardDue?: number;
		advanceTo?: number;
		/** Event actor for run-now; the sweep defaults to the owning user, no key. */
		actor?: { userId: string; apiKeyId: string | null };
	}
): { issueId: string; queries: CompiledQuery[] } {
	const { now, manual, guardDue, advanceTo } = opts;
	const vars = templateVars(schedule.name, schedule.run_count + 1, schedule.timezone, now);
	const title = renderTemplate(schedule.title_template, vars);
	const description = renderTemplate(schedule.description_template, vars);
	const issueId = newId('iss');

	const guard =
		guardDue === undefined
			? sql`1`
			: sql`EXISTS (SELECT 1 FROM scheduled_task WHERE id = ${schedule.id} AND next_run_at = ${guardDue})`;

	const issueInsert = sql`
		INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, scheduled_task_id, created_at, updated_at)
		SELECT ${issueId}, ${schedule.project_id},
			${nextIssueNumber(schedule.project_id)},
			${title}, ${description}, ${schedule.workflow_id}, ${schedule.start_state_id},
			${schedule.id}, ${now}, ${now}
		WHERE ${guard}`.compile(db);

	const payload: Record<string, unknown> = {
		title,
		workflow_id: schedule.workflow_id,
		state_id: schedule.start_state_id,
		state_name: schedule.start_state_name,
		scheduled_task_id: schedule.id,
		scheduled_task_name: schedule.name,
		...(manual ? { manual: true } : {})
	};
	const eventInsert = scheduleEventInsert(db, schedule, 'issue.created', payload, {
		issueId,
		now,
		guardDue,
		actor: opts.actor
	});

	let update = db
		.updateTable('scheduled_task')
		.set({ last_run_at: now, run_count: sql<number>`run_count + 1` })
		.where('id', '=', schedule.id);
	if (advanceTo !== undefined) update = update.set({ next_run_at: advanceTo });
	if (guardDue !== undefined) update = update.where('next_run_at', '=', guardDue);

	return { issueId, queries: [issueInsert, eventInsert, update.compile()] };
}

/**
 * Event insert attributed to the schedule's owning user (no session, no API
 * key), optionally guarded on next_run_at like the other sweep statements.
 */
export function scheduleEventInsert(
	db: Kysely<Database>,
	schedule: Pick<ScheduleExecRow, 'id' | 'project_id' | 'user_id'>,
	type: string,
	payload: Record<string, unknown>,
	opts: {
		issueId?: string | null;
		now: number;
		guardDue?: number;
		actor?: { userId: string; apiKeyId: string | null };
	}
): CompiledQuery {
	const guard =
		opts.guardDue === undefined
			? sql`1`
			: sql`EXISTS (SELECT 1 FROM scheduled_task WHERE id = ${schedule.id} AND next_run_at = ${opts.guardDue})`;
	const actorUserId = opts.actor?.userId ?? schedule.user_id;
	const actorApiKeyId = opts.actor?.apiKeyId ?? null;
	return sql`
		INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
		SELECT ${newId('evt')}, ${schedule.user_id}, ${type}, ${actorUserId}, ${actorApiKeyId},
			${opts.issueId ?? null}, ${schedule.project_id}, ${JSON.stringify(payload)}, ${opts.now}
		WHERE ${guard}`.compile(db);
}

async function runBatch(env: Env, queries: CompiledQuery[]): Promise<void> {
	await env.DB.batch(
		queries.map((q) => env.DB.prepare(q.sql).bind(...(q.parameters as unknown[])))
	);
}

/** One due schedule: create an instance or record a gated skip, then advance. */
async function runDueSchedule(
	db: Kysely<Database>,
	env: Env,
	schedule: ScheduleExecRow,
	now: number
): Promise<void> {
	// Advancing to the next *future* occurrence collapses any missed
	// intermediates: at most one issue per schedule per sweep.
	const nextRun = nextOccurrenceFromCron(schedule.cron, schedule.timezone, now);
	const due = schedule.next_run_at;

	if (schedule.require_all_closed) {
		const blockers = await openInstancesQuery(db, schedule.id).execute();
		if (blockers.length > 0) {
			// Skips are terminal: record the event and move on to the next
			// occurrence; nothing is queued or retried.
			await runBatch(env, [
				scheduleEventInsert(
					db,
					schedule,
					'scheduled_task.skipped',
					{
						schedule_id: schedule.id,
						name: schedule.name,
						occurrence: due,
						blocking: blockers.map((b) => ({ issue_id: b.id, number: b.number }))
					},
					{ now, guardDue: due }
				),
				db
					.updateTable('scheduled_task')
					.set({ next_run_at: nextRun })
					.where('id', '=', schedule.id)
					.where('next_run_at', '=', due)
					.compile()
			]);
			return;
		}
	}

	const { queries } = instanceInserts(db, schedule, {
		now,
		manual: false,
		guardDue: due,
		advanceTo: nextRun
	});
	await runBatch(env, queries);
}

/**
 * The Cron Trigger entry point: create issues for every due, enabled
 * schedule. One schedule failing (bad timezone data, FK surprise) must not
 * abort the rest of the sweep.
 */
export async function sweepSchedules(env: Env, now: number = Date.now()): Promise<void> {
	const db = getDb(env);
	const due = await scheduleExecQuery(db)
		.where('scheduled_task.enabled', '=', 1)
		.where('scheduled_task.next_run_at', '<=', now)
		// An archived project's schedules are paused, not disabled: `enabled`
		// records the operator's intent so unarchive can restore it. Skipping
		// is silent — a paused schedule is not an incident.
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
