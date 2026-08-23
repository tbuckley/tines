import {
	compilePreset,
	describeRecurrence,
	nextOccurrenceFromCron,
	ScheduleInputError,
	validateScheduleCron,
	validateTimezone,
	type CreateScheduleInput,
	type Schedule,
	type SchedulePreset,
	type UpdateScheduleRequest
} from '@tines/shared';
import type { Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import {
	instanceInserts,
	openInstancesQuery,
	scheduleEventInsert,
	scheduleExecQuery,
	type ScheduleExecRow
} from '$lib/server/schedule-sweep';
import {
	ApiFail,
	notFound,
	optionalString,
	requireString,
	runAtomic,
	type ActorContext,
	type Page
} from './core';
import { eventInsert } from './events';

// ---------------------------------------------------------------------------
// Recurrence input validation

export interface ResolvedRecurrence {
	/** The compiled cron expression (always populated). */
	cron: string;
	/** JSON-encoded preset for round-tripping; null = raw cron. */
	presetJson: string | null;
	preset: SchedulePreset | null;
}

/** ScheduleInputError (bad cron/preset/timezone) → structured 422. */
function inputFail(e: unknown, code: string): never {
	if (e instanceof ScheduleInputError) throw new ApiFail(422, code, e.message);
	throw e;
}

/** Validates `preset`/`cron` (exactly one) and compiles to cron. */
export function resolveRecurrence(input: { preset?: unknown; cron?: unknown }): ResolvedRecurrence {
	const hasPreset = input.preset !== undefined && input.preset !== null;
	const hasCron = input.cron !== undefined && input.cron !== null;
	if (hasPreset === hasCron) {
		throw new ApiFail(
			422,
			'invalid_recurrence',
			'Pass exactly one of "preset" (daily/weekly/monthly) or "cron" for the recurrence'
		);
	}
	if (hasPreset) {
		const preset = input.preset as SchedulePreset;
		try {
			const cron = compilePreset(preset);
			validateScheduleCron(cron);
			// Store only the round-trippable fields, not whatever else came in.
			const clean: SchedulePreset = {
				kind: preset.kind,
				time: preset.time,
				...(preset.kind === 'weekly' ? { weekday: preset.weekday } : {}),
				...(preset.kind === 'monthly' ? { day_of_month: preset.day_of_month } : {})
			};
			return { cron, presetJson: JSON.stringify(clean), preset: clean };
		} catch (e) {
			inputFail(e, 'invalid_recurrence');
		}
	}
	const cron = requireString(input.cron, 'cron', { max: 100 }).trim();
	try {
		validateScheduleCron(cron);
	} catch (e) {
		inputFail(e, 'invalid_cron');
	}
	return { cron, presetJson: null, preset: null };
}

export function resolveTimezone(tz: unknown): string {
	if (tz === undefined || tz === null || tz === '') return 'UTC';
	try {
		return validateTimezone(requireString(tz, 'timezone', { max: 100 }).trim());
	} catch (e) {
		inputFail(e, 'invalid_timezone');
	}
}

async function assertScheduleNameAvailable(
	db: Kysely<Database>,
	projectId: string,
	name: string,
	excludeId?: string
) {
	let q = db
		.selectFrom('scheduled_task')
		.select('id')
		.where('project_id', '=', projectId)
		.where('name', '=', name);
	if (excludeId) q = q.where('id', '!=', excludeId);
	const existing = await q.executeTakeFirst();
	if (existing) {
		throw new ApiFail(
			422,
			'duplicate_schedule_name',
			`A schedule named "${name}" already exists in this project; schedule names must be unique per project`,
			{ field: 'name', existing_schedule_id: existing.id }
		);
	}
}

// ---------------------------------------------------------------------------
// Loading

export function scheduleQuery(db: Kysely<Database>, userId: string) {
	return db
		.selectFrom('scheduled_task')
		.innerJoin('project', 'project.id', 'scheduled_task.project_id')
		.innerJoin('workflow', 'workflow.id', 'scheduled_task.workflow_id')
		.selectAll('scheduled_task')
		.select(['project.name as project_name', 'workflow.name as workflow_name'])
		.select((eb) =>
			eb
				.selectFrom('issue')
				.innerJoin('workflow_state as state', 'state.id', 'issue.state_id')
				.whereRef('issue.scheduled_task_id', '=', 'scheduled_task.id')
				.where('state.category', '!=', 'done')
				.select((eb2) => eb2.fn.countAll<number>().as('n'))
				.as('open_instances')
		)
		.where('project.user_id', '=', userId);
}

type ScheduleRow = Awaited<ReturnType<ReturnType<typeof scheduleQuery>['execute']>>[number];

export function serializeSchedule(row: ScheduleRow): Schedule {
	let preset: SchedulePreset | null = null;
	if (row.preset) {
		try {
			preset = JSON.parse(row.preset) as SchedulePreset;
		} catch {
			// Leave preset null if it somehow isn't valid JSON.
		}
	}
	return {
		id: row.id,
		project_id: row.project_id,
		project_name: row.project_name,
		name: row.name,
		title_template: row.title_template,
		description_template: row.description_template,
		workflow_id: row.workflow_id,
		workflow_name: row.workflow_name,
		cron: row.cron,
		preset,
		timezone: row.timezone,
		require_all_closed: row.require_all_closed === 1,
		enabled: row.enabled === 1,
		next_run_at: row.next_run_at,
		last_run_at: row.last_run_at,
		run_count: row.run_count,
		open_instances: Number(row.open_instances ?? 0),
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

export interface ScheduleListFilters {
	/** Project id or name. */
	project?: string;
	enabled?: boolean;
	/** Restrict to one project id (the nested per-project route). */
	projectId?: string;
}

export async function listSchedules(
	db: Kysely<Database>,
	userId: string,
	filters: ScheduleListFilters,
	page: Page
): Promise<{ items: Schedule[]; hasMore: boolean }> {
	let q = scheduleQuery(db, userId);
	if (filters.projectId) q = q.where('scheduled_task.project_id', '=', filters.projectId);
	if (filters.project) {
		const p = filters.project;
		q = q.where((eb) => eb.or([eb('project.id', '=', p), eb('project.name', '=', p)]));
	}
	if (filters.enabled !== undefined) {
		q = q.where('scheduled_task.enabled', '=', filters.enabled ? 1 : 0);
	}
	if (page.cursor) {
		const { createdAt, id } = page.cursor;
		q = q.where((eb) =>
			eb.or([
				eb('scheduled_task.created_at', '<', createdAt),
				eb.and([eb('scheduled_task.created_at', '=', createdAt), eb('scheduled_task.id', '<', id)])
			])
		);
	}
	const rows = await q
		.orderBy('scheduled_task.created_at desc')
		.orderBy('scheduled_task.id desc')
		.limit(page.limit + 1)
		.execute();
	return { items: rows.slice(0, page.limit).map(serializeSchedule), hasMore: rows.length > page.limit };
}

export async function getSchedule(
	db: Kysely<Database>,
	userId: string,
	id: string
): Promise<Schedule> {
	const row = await scheduleQuery(db, userId).where('scheduled_task.id', '=', id).executeTakeFirst();
	if (!row) throw notFound();
	return serializeSchedule(row);
}

/** The exec-shaped row (owner, initial state) for run-now, user-scoped. */
async function getScheduleExecRow(
	db: Kysely<Database>,
	userId: string,
	id: string
): Promise<ScheduleExecRow> {
	const row = await scheduleExecQuery(db)
		.where('scheduled_task.id', '=', id)
		.where('project.user_id', '=', userId)
		.executeTakeFirst();
	if (!row) throw notFound();
	return row;
}

// ---------------------------------------------------------------------------
// Creation (rides along with issue creation; see createIssue in issues.ts)

export interface PreparedSchedule {
	id: string;
	name: string;
	recurrence: ResolvedRecurrence;
	timezone: string;
	requireAllClosed: boolean;
	nextRunAt: number;
}

/**
 * Validates the `schedule` part of a create-issue request. `title` is the
 * title template; it doubles as the default name.
 */
export async function prepareSchedule(
	db: Kysely<Database>,
	projectId: string,
	input: CreateScheduleInput,
	titleTemplate: string,
	now: number
): Promise<PreparedSchedule> {
	const name = (optionalString(input.name, 'schedule.name', { max: 200 })?.trim() || titleTemplate).slice(0, 200);
	const recurrence = resolveRecurrence(input);
	const timezone = resolveTimezone(input.timezone);
	await assertScheduleNameAvailable(db, projectId, name);
	let nextRunAt: number;
	try {
		nextRunAt = nextOccurrenceFromCron(recurrence.cron, timezone, now);
	} catch (e) {
		inputFail(e, 'invalid_recurrence');
	}
	return {
		id: newId('sch'),
		name,
		recurrence,
		timezone,
		requireAllClosed: input.require_all_closed === true,
		nextRunAt
	};
}

// ---------------------------------------------------------------------------
// Mutations

export async function updateSchedule(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	body: UpdateScheduleRequest
): Promise<Schedule> {
	const current = await getSchedule(db, actor.userId, id);

	const name = body.name !== undefined ? requireString(body.name, 'name', { max: 200 }).trim() : current.name;
	const titleTemplate =
		body.title_template !== undefined
			? requireString(body.title_template, 'title_template', { max: 500 }).trim()
			: current.title_template;
	const descriptionTemplate =
		body.description_template !== undefined
			? (optionalString(body.description_template, 'description_template') ?? '')
			: current.description_template;

	const recurrenceEdited = body.preset !== undefined || body.cron !== undefined;
	const recurrence: ResolvedRecurrence = recurrenceEdited
		? resolveRecurrence(body)
		: { cron: current.cron, presetJson: current.preset ? JSON.stringify(current.preset) : null, preset: current.preset };
	const timezone = body.timezone !== undefined ? resolveTimezone(body.timezone) : current.timezone;

	const requireAllClosed =
		body.require_all_closed !== undefined ? body.require_all_closed === true : current.require_all_closed;
	const enabled = body.enabled !== undefined ? body.enabled === true : current.enabled;

	if (name !== current.name) {
		await assertScheduleNameAvailable(db, current.project_id, name, id);
	}

	// next_run_at is recomputed when the recurrence or timezone changes, or
	// when a paused schedule resumes — from now, so the paused span is never
	// backfilled.
	const now = Date.now();
	const resumed = enabled && !current.enabled;
	let nextRunAt = current.next_run_at;
	if (recurrenceEdited || timezone !== current.timezone || resumed) {
		try {
			nextRunAt = nextOccurrenceFromCron(recurrence.cron, timezone, now);
		} catch (e) {
			inputFail(e, 'invalid_recurrence');
		}
	}

	// Summary diff for the scheduled_task.updated event payload.
	const payload: Record<string, unknown> = { schedule_id: id, name };
	if (name !== current.name) payload.renamed = { from: current.name, to: name };
	if (titleTemplate !== current.title_template) payload.title_template_changed = true;
	if (descriptionTemplate !== current.description_template) payload.description_template_changed = true;
	if (recurrenceEdited && recurrence.cron !== current.cron) {
		payload.recurrence = {
			from: describeRecurrence(current.preset, current.cron),
			to: describeRecurrence(recurrence.preset, recurrence.cron)
		};
	}
	if (timezone !== current.timezone) payload.timezone = { from: current.timezone, to: timezone };
	if (requireAllClosed !== current.require_all_closed) {
		payload.require_all_closed = { from: current.require_all_closed, to: requireAllClosed };
	}
	if (enabled !== current.enabled) payload.enabled = { from: current.enabled, to: enabled };

	const changed = Object.keys(payload).length > 2;
	if (!changed && nextRunAt === current.next_run_at) return current;

	await runAtomic(env, [
		db
			.updateTable('scheduled_task')
			.set({
				name,
				title_template: titleTemplate,
				description_template: descriptionTemplate,
				cron: recurrence.cron,
				preset: recurrence.presetJson,
				timezone,
				require_all_closed: requireAllClosed ? 1 : 0,
				enabled: enabled ? 1 : 0,
				next_run_at: nextRunAt,
				updated_at: now
			})
			.where('id', '=', id)
			.compile(),
		...(changed
			? [eventInsert(db, actor, { type: 'scheduled_task.updated', projectId: current.project_id, payload })]
			: [])
	]);
	return getSchedule(db, actor.userId, id);
}

export async function deleteSchedule(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string
): Promise<void> {
	const current = await getSchedule(db, actor.userId, id);
	await runAtomic(env, [
		// Explicitly unlink issues (the FK's SET NULL is the backstop); their
		// issue.created events keep the schedule's identity for history.
		db.updateTable('issue').set({ scheduled_task_id: null }).where('scheduled_task_id', '=', id).compile(),
		db.deleteFrom('scheduled_task').where('id', '=', id).compile(),
		eventInsert(db, actor, {
			type: 'scheduled_task.deleted',
			projectId: current.project_id,
			payload: { schedule_id: id, name: current.name }
		})
	]);
}

/**
 * Run now: create an instance immediately. Respects the gate (422 naming the
 * open instances), leaves next_run_at untouched, and works on paused
 * schedules. The issue.created payload carries `manual: true`. Returns the
 * created issue's id (the route loads the detail — avoids an import cycle
 * with issues.ts).
 */
export async function runScheduleNow(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string
): Promise<string> {
	const schedule = await getScheduleExecRow(db, actor.userId, id);

	if (schedule.require_all_closed) {
		const blockers = await openInstancesQuery(db, schedule.id).execute();
		if (blockers.length > 0) {
			throw new ApiFail(
				422,
				'schedule_blocked',
				`Schedule "${schedule.name}" requires all previous instances to be closed; ${blockers.length} still open: ${blockers
					.map((b) => `#${b.number} "${b.title}"`)
					.join(', ')}`,
				{ open_instances: blockers.map((b) => ({ issue_id: b.id, number: b.number, title: b.title })) }
			);
		}
	}

	const { issueId, queries } = instanceInserts(db, schedule, {
		now: Date.now(),
		manual: true,
		actor: { userId: actor.userId, apiKeyId: actor.apiKeyId }
	});
	await runAtomic(env, queries);
	return issueId;
}

// ---------------------------------------------------------------------------
// Cross-entity guards

/** A workflow cannot be deleted while a schedule references it. */
export async function assertWorkflowNotScheduled(
	db: Kysely<Database>,
	workflowId: string,
	workflowName: string
): Promise<void> {
	const schedules = await db
		.selectFrom('scheduled_task')
		.select(['id', 'name'])
		.where('workflow_id', '=', workflowId)
		.execute();
	if (schedules.length > 0) {
		throw new ApiFail(
			422,
			'workflow_in_use',
			`Cannot delete workflow "${workflowName}": ${schedules.length} scheduled task${schedules.length === 1 ? '' : 's'} still reference${schedules.length === 1 ? 's' : ''} it (${schedules
				.map((s) => `"${s.name}"`)
				.join(', ')})`,
			{ schedules: schedules.map((s) => ({ id: s.id, name: s.name })) }
		);
	}
}

/** Statements deleting a project's schedules (project deletion), with events. */
export async function projectScheduleDeletions(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string
) {
	const schedules = await db
		.selectFrom('scheduled_task')
		.select(['id', 'name'])
		.where('project_id', '=', projectId)
		.execute();
	return schedules.flatMap((s) => [
		db.deleteFrom('scheduled_task').where('id', '=', s.id).compile(),
		eventInsert(db, actor, {
			type: 'scheduled_task.deleted',
			payload: { schedule_id: s.id, name: s.name, project_id: projectId }
		})
	]);
}
