import {
	compilePreset,
	describeRecurrence,
	nextOccurrenceFromCron,
	ScheduleInputError,
	validateScheduleCron,
	validateTimezone,
	type ArchivedFilter,
	type CreateScheduleInput,
	type Schedule,
	type SchedulePreset,
	type UpdateScheduleRequest
} from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import {
	buildScheduleExecution,
	parseExecutionReceipt,
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
import { assertWritable, projectArchivedError } from './archive';
import type { DispatchEffects } from '$lib/server/dispatch-effects';
import { eventInsert } from './events';
import { insertValues, type QueryGuard } from './query-guard';
import {
	invalidateSchedulePermissionQueries,
	revokeInheritedScheduleQueries
} from './schedule-consent';
import { assertConsentFieldsSupported } from './personal-consent';
import { projectReadPredicate, requireAccess } from './permissions';

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
			const clean: SchedulePreset =
				preset.kind === 'hourly'
					? { kind: 'hourly', every_hours: preset.every_hours, minute: preset.minute ?? 0 }
					: {
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

// ---------------------------------------------------------------------------
// Workflow / start-state resolution
//
// schedules.ts cannot import workflows.ts or issues.ts (both import from
// here), so the workflow lookup and state resolution live here in the small
// form the schedule needs.

export interface ScheduleWorkflow {
	id: string;
	name: string;
	initial_state_id: string;
	states: { id: string; name: string }[];
}

/** The workflow (user's library or system) with its states, or a 422. */
async function loadScheduleWorkflow(
	db: Kysely<Database>,
	userId: string,
	workflowId: string
): Promise<ScheduleWorkflow> {
	const wf = await db
		.selectFrom('workflow')
		.select(['id', 'name', 'initial_state_id'])
		.where('id', '=', workflowId)
		.where((eb) => eb.or([eb('user_id', '=', userId), eb('user_id', 'is', null)]))
		.executeTakeFirst();
	if (!wf) {
		throw new ApiFail(422, 'unknown_workflow', `Workflow "${workflowId}" does not exist`, {
			field: 'workflow_id'
		});
	}
	const states = await db
		.selectFrom('workflow_state')
		.select(['id', 'name'])
		.where('workflow_id', '=', workflowId)
		.orderBy('position asc')
		.execute();
	return { ...wf, states };
}

/**
 * Resolves a start-state reference (id or name) within the workflow. The
 * workflow's initial state normalizes to null — "follow the workflow's
 * initial state" — so the schedule tracks the workflow if that changes.
 */
export function resolveStartState(
	workflow: ScheduleWorkflow,
	ref: string,
	options: { preserveExplicitInitial?: boolean } = {}
): string | null {
	const state =
		workflow.states.find((s) => s.id === ref) ?? workflow.states.find((s) => s.name === ref);
	if (!state) {
		throw new ApiFail(422, 'unknown_state', `Workflow "${workflow.name}" has no state "${ref}"`, {
			field: 'state',
			known_states: workflow.states.map((s) => ({ id: s.id, name: s.name }))
		});
	}
	return !options.preserveExplicitInitial && state.id === workflow.initial_state_id
		? null
		: state.id;
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
		.leftJoin('workflow_state as start_state', 'start_state.id', 'scheduled_task.state_id')
		.leftJoin('schedule_personal_choice as my_choice', (join) =>
			join
				.onRef('my_choice.schedule_id', '=', 'scheduled_task.id')
				.on('my_choice.user_id', '=', userId)
		)
		.selectAll('scheduled_task')
		.select([
			'project.name as project_name',
			'project.archived_at as project_archived_at',
			'project.shared_at as project_shared_at',
			'workflow.name as workflow_name',
			'start_state.name as state_name',
			'my_choice.value as my_choice_value',
			'my_choice.revision as my_choice_revision',
			'my_choice.permission_epoch as my_choice_epoch'
		])
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
		project_archived_at: row.project_archived_at,
		name: row.name,
		title_template: row.title_template,
		description_template: row.description_template,
		workflow_id: row.workflow_id,
		workflow_name: row.workflow_name,
		state_id: row.state_id,
		state_name: row.state_name,
		cron: row.cron,
		preset,
		timezone: row.timezone,
		require_all_closed: row.require_all_closed === 1,
		enabled: row.enabled === 1,
		next_run_at: row.next_run_at,
		last_run_at: row.last_run_at,
		run_count: row.run_count,
		open_instances: Number(row.open_instances ?? 0),
		permission_epoch: row.permission_epoch,
		...(row.project_shared_at !== null
			? {
					my_future_permission: {
						value:
							row.my_choice_epoch === row.permission_epoch
								? (row.my_choice_value ?? 'unset')
								: 'unset',
						revision: row.my_choice_revision ?? 0,
						epoch: row.permission_epoch
					}
				}
			: {}),
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
	/** Archived projects' schedules, when no project is named; default `'false'`. */
	archived?: ArchivedFilter;
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
	// A named project lists its schedules whatever its state; without one,
	// archived projects drop out by default.
	if (!filters.projectId && !filters.project) {
		if ((filters.archived ?? 'false') === 'false') q = q.where('project.archived_at', 'is', null);
		else if (filters.archived === 'true') q = q.where('project.archived_at', 'is not', null);
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
	return {
		items: rows.slice(0, page.limit).map(serializeSchedule),
		hasMore: rows.length > page.limit
	};
}

export async function listSchedulesForActor(
	db: Kysely<Database>,
	actor: ActorContext,
	filters: ScheduleListFilters,
	page: Page
): Promise<{ items: Schedule[]; hasMore: boolean }> {
	let q = scheduleQuery(db, actor.userId).where(
		projectReadPredicate(actor, 'scheduled_task.project_id')
	);
	if (filters.projectId) q = q.where('scheduled_task.project_id', '=', filters.projectId);
	if (filters.project) {
		const p = filters.project;
		q = q.where((eb) => eb.or([eb('project.id', '=', p), eb('project.name', '=', p)]));
	}
	if (filters.enabled !== undefined) {
		q = q.where('scheduled_task.enabled', '=', filters.enabled ? 1 : 0);
	}
	if (!filters.projectId && !filters.project) {
		if ((filters.archived ?? 'false') === 'false') q = q.where('project.archived_at', 'is', null);
		else if (filters.archived === 'true') q = q.where('project.archived_at', 'is not', null);
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
	return {
		items: rows.slice(0, page.limit).map(serializeSchedule),
		hasMore: rows.length > page.limit
	};
}

export async function getSchedule(
	db: Kysely<Database>,
	userId: string,
	id: string
): Promise<Schedule> {
	const row = await scheduleQuery(db, userId)
		.where('scheduled_task.id', '=', id)
		.executeTakeFirst();
	if (!row) throw notFound();
	return serializeSchedule(row);
}

export async function getScheduleForActor(
	db: Kysely<Database>,
	actor: ActorContext,
	id: string
): Promise<Schedule> {
	const row = await scheduleQuery(db, actor.userId)
		.where(projectReadPredicate(actor, 'scheduled_task.project_id'))
		.where('scheduled_task.id', '=', id)
		.executeTakeFirst();
	if (!row) throw notFound();
	const schedule = serializeSchedule(row);
	requireAccess(
		actor,
		[{ domain: 'project', access: 'read', projectId: schedule.project_id }],
		'schedule.read',
		{ projectId: schedule.project_id }
	);
	return schedule;
}

async function getScheduleExecRowForActor(
	db: Kysely<Database>,
	actor: ActorContext,
	id: string
): Promise<ScheduleExecRow> {
	const row = await scheduleExecQuery(db)
		.where('scheduled_task.id', '=', id)
		.where('project.user_id', '=', actor.userId)
		.where(projectReadPredicate(actor, 'scheduled_task.project_id'))
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
	const prepared = validateScheduleCreateFields(input, titleTemplate, now);
	await assertScheduleNameAvailable(db, projectId, prepared.name);
	return { id: newId('sch'), ...prepared };
}

/** Pure recurrence/name validation, also usable before prospective workflows exist. */
export function validateScheduleCreateFields(
	input: CreateScheduleInput,
	titleTemplate: string,
	now: number
): Omit<PreparedSchedule, 'id'> {
	const name = (
		optionalString(input.name, 'schedule.name', { max: 200 })?.trim() || titleTemplate
	).slice(0, 200);
	const recurrence = resolveRecurrence(input);
	const timezone = resolveTimezone(input.timezone);
	let nextRunAt: number;
	try {
		nextRunAt = nextOccurrenceFromCron(recurrence.cron, timezone, now);
	} catch (e) {
		inputFail(e, 'invalid_recurrence');
	}
	return {
		name,
		recurrence,
		timezone,
		requireAllClosed: input.require_all_closed === true,
		nextRunAt
	};
}

// ---------------------------------------------------------------------------
// Mutations

/**
 * Ordinary schedule row/event builder. Defaults to a paused, never-run schedule.
 * The initial-issue mode is for createIssue, which supplies the first instance
 * separately in the same batch; this function never creates or dispatches work.
 */
export function scheduleInsertQueries(
	db: Kysely<Database>,
	actor: ActorContext,
	options: {
		schedule: PreparedSchedule;
		projectId: string;
		workflowId: string;
		stateId: string | null;
		stateName: string | null;
		titleTemplate: string;
		descriptionTemplate: string;
		now: number;
		mode?: 'paused' | 'initial-issue';
		guard?: QueryGuard;
		eventGuard?: QueryGuard;
		eventId?: string;
	}
): [CompiledQuery, CompiledQuery] {
	const { schedule, projectId, workflowId, stateId, stateName, now } = options;
	const initial = options.mode === 'initial-issue';
	return [
		insertValues(
			db,
			'scheduled_task',
			{
				id: schedule.id,
				project_id: projectId,
				name: schedule.name,
				title_template: options.titleTemplate,
				description_template: options.descriptionTemplate,
				workflow_id: workflowId,
				state_id: stateId,
				cron: schedule.recurrence.cron,
				preset: schedule.recurrence.presetJson,
				timezone: schedule.timezone,
				require_all_closed: schedule.requireAllClosed ? 1 : 0,
				enabled: initial ? 1 : 0,
				next_run_at: schedule.nextRunAt,
				last_run_at: initial ? now : null,
				run_count: initial ? 1 : 0,
				definition_revision: 1,
				permission_epoch: 0,
				last_update_token: null,
				created_at: now,
				updated_at: now
			},
			options.guard
		),
		eventInsert(
			db,
			actor,
			{
				id: options.eventId,
				createdAt: now,
				type: 'scheduled_task.created',
				projectId,
				payload: {
					schedule_id: schedule.id,
					name: schedule.name,
					cron: schedule.recurrence.cron,
					timezone: schedule.timezone,
					require_all_closed: schedule.requireAllClosed,
					...(stateId ? { start_state: stateName } : {}),
					...(!initial ? { enabled: false, initial_issue_created: false } : {})
				}
			},
			options.eventGuard ?? options.guard
		)
	];
}

/** The gate's view of a schedule's project. */
function scheduleProject(s: Schedule) {
	return { id: s.project_id, name: s.project_name, archived_at: s.project_archived_at };
}

export async function updateSchedule(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	body: UpdateScheduleRequest
): Promise<Schedule> {
	assertConsentFieldsSupported(actor, body);
	const currentRow = await scheduleQuery(db, actor.userId)
		.where(projectReadPredicate(actor, 'scheduled_task.project_id'))
		.where('scheduled_task.id', '=', id)
		.executeTakeFirst();
	if (!currentRow) throw notFound();
	const current = serializeSchedule(currentRow);
	requireAccess(
		actor,
		[{ domain: 'project', access: 'write', projectId: current.project_id }],
		'schedule.update',
		{ projectId: current.project_id }
	);
	if (body.workflow_id !== undefined || body.state !== undefined) {
		requireAccess(actor, [{ domain: 'workspace', access: 'read' }], 'schedule.update', {
			projectId: current.project_id
		});
	}
	const revision = currentRow.definition_revision;
	await assertWritable(db, actor, scheduleProject(current));

	const name =
		body.name !== undefined ? requireString(body.name, 'name', { max: 200 }).trim() : current.name;
	const titleTemplate =
		body.title_template !== undefined
			? requireString(body.title_template, 'title_template', { max: 500 }).trim()
			: current.title_template;
	const descriptionTemplate =
		body.description_template !== undefined
			? (optionalString(body.description_template, 'description_template') ?? '')
			: current.description_template;

	// Workflow / start state: changing the workflow resets a pinned state
	// (it belongs to the old workflow) unless the same request picks one.
	let workflowId = current.workflow_id;
	let workflowName = current.workflow_name;
	let stateId = current.state_id;
	let stateName = current.state_name;
	if (body.workflow_id !== undefined || body.state !== undefined) {
		const targetWorkflowId =
			body.workflow_id !== undefined
				? requireString(body.workflow_id, 'workflow_id', { max: 100 }).trim()
				: current.workflow_id;
		const workflow = await loadScheduleWorkflow(db, actor.userId, targetWorkflowId);
		workflowId = workflow.id;
		workflowName = workflow.name;
		if (body.state !== undefined) {
			stateId =
				body.state === null
					? null
					: resolveStartState(workflow, requireString(body.state, 'state', { max: 100 }).trim());
		} else if (workflowId !== current.workflow_id) {
			stateId = null;
		}
		stateName = stateId ? (workflow.states.find((s) => s.id === stateId)?.name ?? null) : null;
	}

	const recurrenceEdited = body.preset !== undefined || body.cron !== undefined;
	const recurrence: ResolvedRecurrence = recurrenceEdited
		? resolveRecurrence(body)
		: {
				cron: current.cron,
				presetJson: current.preset ? JSON.stringify(current.preset) : null,
				preset: current.preset
			};
	const timezone = body.timezone !== undefined ? resolveTimezone(body.timezone) : current.timezone;

	const requireAllClosed =
		body.require_all_closed !== undefined
			? body.require_all_closed === true
			: current.require_all_closed;
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
	if (descriptionTemplate !== current.description_template)
		payload.description_template_changed = true;
	if (recurrenceEdited && recurrence.cron !== current.cron) {
		payload.recurrence = {
			from: describeRecurrence(current.preset, current.cron),
			to: describeRecurrence(recurrence.preset, recurrence.cron)
		};
	}
	if (timezone !== current.timezone) payload.timezone = { from: current.timezone, to: timezone };
	if (workflowId !== current.workflow_id) {
		payload.workflow = { from: current.workflow_name, to: workflowName };
	}
	if (stateId !== current.state_id) {
		// null = the workflow's initial state.
		payload.start_state = { from: current.state_name, to: stateName };
	}
	if (requireAllClosed !== current.require_all_closed) {
		payload.require_all_closed = { from: current.require_all_closed, to: requireAllClosed };
	}
	if (enabled !== current.enabled) payload.enabled = { from: current.enabled, to: enabled };

	const changed = Object.keys(payload).length > 2;
	if (!changed && nextRunAt === current.next_run_at) return current;
	const permissionChanged =
		titleTemplate !== current.title_template ||
		descriptionTemplate !== current.description_template ||
		workflowId !== current.workflow_id ||
		stateId !== current.state_id ||
		recurrence.cron !== current.cron ||
		recurrence.presetJson !== currentRow.preset ||
		timezone !== current.timezone ||
		requireAllClosed !== current.require_all_closed;
	const updateToken = newId('dcn');
	const eventId = newId('evt');
	const updateQuery = db
		.updateTable('scheduled_task')
		.set({
			name,
			title_template: titleTemplate,
			description_template: descriptionTemplate,
			workflow_id: workflowId,
			state_id: stateId,
			cron: recurrence.cron,
			preset: recurrence.presetJson,
			timezone,
			require_all_closed: requireAllClosed ? 1 : 0,
			enabled: enabled ? 1 : 0,
			...(recurrenceEdited || timezone !== current.timezone || resumed
				? { next_run_at: nextRunAt }
				: {}),
			definition_revision: sql<number>`definition_revision + 1`,
			last_update_token: updateToken,
			...(permissionChanged ? { permission_epoch: sql<number>`permission_epoch + 1` } : {}),
			updated_at: now
		})
		.where('id', '=', id)
		.where('definition_revision', '=', revision)
		.where(
			sql<boolean>`EXISTS (
				SELECT 1 FROM project
				WHERE project.id = ${current.project_id}
				  AND project.user_id = ${actor.userId}
				  AND project.archived_at IS NULL
			)`
		)
		.compile();
	const results = await runAtomic(env, [
		updateQuery,
		eventInsert(
			db,
			actor,
			{ id: eventId, type: 'scheduled_task.updated', projectId: current.project_id, payload },
			{
				predicate: sql<boolean>`EXISTS (SELECT 1 FROM scheduled_task
					WHERE id = ${id} AND last_update_token = ${updateToken})`
			}
		),
		...(permissionChanged ? invalidateSchedulePermissionQueries(db, id, updateToken, now) : []),
		sql`SELECT id FROM scheduled_task WHERE id = ${id}
			AND last_update_token = ${updateToken}
			AND EXISTS (SELECT 1 FROM event WHERE id = ${eventId})`.compile(db)
	]);
	if (results.at(-1)?.results?.length !== 1) {
		const latestRow = await scheduleQuery(db, actor.userId)
			.where(projectReadPredicate(actor, 'scheduled_task.project_id'))
			.where('scheduled_task.id', '=', id)
			.executeTakeFirst();
		if (!latestRow) throw notFound();
		const latest = serializeSchedule(latestRow);
		await assertWritable(db, actor, scheduleProject(latest));
		throw new ApiFail(
			409,
			'schedule_changed',
			'Schedule changed while it was being edited. Reload the schedule and try again.'
		);
	}
	return getScheduleForActor(db, actor, id);
}

export async function deleteSchedule(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string
): Promise<void> {
	const current = await getScheduleForActor(db, actor, id);
	requireAccess(
		actor,
		[{ domain: 'project', access: 'delete', projectId: current.project_id }],
		'schedule.delete',
		{ projectId: current.project_id }
	);
	await assertWritable(db, actor, scheduleProject(current));
	const now = Date.now();
	const eventId = newId('evt');
	const guard = sql<boolean>`EXISTS (SELECT 1 FROM scheduled_task s
		JOIN project p ON p.id = s.project_id
		WHERE s.id = ${id} AND p.user_id = ${actor.userId}
			AND p.archived_at IS NULL)`;
	const results = await runAtomic(env, [
		eventInsert(
			db,
			actor,
			{
				id: eventId,
				type: 'scheduled_task.deleted',
				projectId: current.project_id,
				payload: { schedule_id: id, name: current.name }
			},
			{ predicate: guard }
		),
		...(() => {
			const committed = sql<boolean>`EXISTS (SELECT 1 FROM event WHERE id = ${eventId})`;
			const [clear, release, revokeKeys] = revokeInheritedScheduleQueries(db, id, now, committed);
			return [release, revokeKeys, clear];
		})(),
		// Explicitly unlink issues (the FK's SET NULL is the backstop); their
		// issue.created events keep the schedule's identity for history.
		db
			.updateTable('issue')
			.set({ scheduled_task_id: null })
			.where('scheduled_task_id', '=', id)
			.where(sql<boolean>`EXISTS (SELECT 1 FROM event WHERE id = ${eventId})`)
			.compile(),
		db
			.deleteFrom('scheduled_task')
			.where('id', '=', id)
			.where(sql<boolean>`EXISTS (SELECT 1 FROM event WHERE id = ${eventId})`)
			.compile(),
		sql`SELECT id FROM event WHERE id = ${eventId}
			AND NOT EXISTS (SELECT 1 FROM scheduled_task WHERE id = ${id})`.compile(db)
	]);
	if (results.at(-1)?.results?.length !== 1)
		throw new ApiFail(
			409,
			'schedule_changed',
			'Schedule changed while it was being deleted. Reload and try again.'
		);
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
	effects: DispatchEffects,
	id: string,
	beforeCommit?: () => Promise<void>
): Promise<string> {
	const prepared = await getScheduleExecRowForActor(db, actor, id);
	requireAccess(
		actor,
		[{ domain: 'project', access: 'write', projectId: prepared.project_id }],
		'schedule.run',
		{ projectId: prepared.project_id }
	);
	let attemptSchedule = prepared;
	const preparedStart = {
		definition_revision: prepared.definition_revision,
		workflow_id: prepared.workflow_id,
		state_id: prepared.state_id,
		start_state_id: prepared.start_state_id,
		start_state_name: prepared.start_state_name,
		start_state_category: prepared.start_state_category
	};
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await assertWritable(db, actor, {
			id: attemptSchedule.project_id,
			name: attemptSchedule.project_name,
			archived_at: attemptSchedule.project_archived_at
		});
		const execution = buildScheduleExecution(db, attemptSchedule, {
			now: Date.now(),
			mode: { kind: 'manual', actor: { userId: actor.userId, apiKeyId: actor.apiKeyId } }
		});
		if (beforeCommit) await beforeCommit();
		const results = await runAtomic(env, execution.queries);
		const receipt = parseExecutionReceipt(results[execution.receiptIndex], execution);
		switch (receipt.status) {
			case 'created':
				effects.signalDispatch();
				return execution.issueId;
			case 'blocked': {
				const blockers = receipt.blocking;
				throw new ApiFail(
					422,
					'schedule_blocked',
					`Schedule "${attemptSchedule.name}" requires all previous instances to be closed; ${blockers.length} still open: ${blockers
						.map((b) => `${b.project_name}/${b.number} "${b.title}"`)
						.join(', ')}`,
					{ open_instances: blockers }
				);
			}
			case 'archived':
				throw projectArchivedError({
					id: attemptSchedule.project_id,
					name: attemptSchedule.project_name,
					archived_at: receipt.archived_at ?? Date.now()
				});
			case 'not_found':
				throw notFound();
			case 'count_changed': {
				const refreshed = await getScheduleExecRowForActor(db, actor, id);
				const startChanged =
					refreshed.definition_revision !== preparedStart.definition_revision ||
					refreshed.workflow_id !== preparedStart.workflow_id ||
					refreshed.state_id !== preparedStart.state_id ||
					refreshed.start_state_id !== preparedStart.start_state_id ||
					refreshed.start_state_name !== preparedStart.start_state_name ||
					refreshed.start_state_category !== preparedStart.start_state_category;
				if (startChanged) {
					throw new ApiFail(
						409,
						'schedule_changed',
						'Schedule changed while Run now was being prepared. Reload the schedule and try again.'
					);
				}
				attemptSchedule = refreshed;
				continue;
			}
			case 'definition_changed':
			case 'start_changed':
				throw new ApiFail(
					409,
					'schedule_changed',
					'Schedule changed while Run now was being prepared. Reload the schedule and try again.'
				);
			default:
				throw new ApiFail(409, 'schedule_busy', 'Schedule is busy; try Run now again.');
		}
	}
	throw new ApiFail(409, 'schedule_busy', 'Schedule is busy; try Run now again.');
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

/** A state cannot be deleted while a schedule starts its instances in it. */
export async function assertStatesNotScheduled(
	db: Kysely<Database>,
	stateIds: string[]
): Promise<void> {
	if (stateIds.length === 0) return;
	const schedules = await db
		.selectFrom('scheduled_task')
		.innerJoin('workflow_state as state', 'state.id', 'scheduled_task.state_id')
		.select([
			'scheduled_task.id',
			'scheduled_task.name',
			'state.id as state_id',
			'state.name as state_name'
		])
		.where('scheduled_task.state_id', 'in', stateIds)
		.execute();
	if (schedules.length > 0) {
		throw new ApiFail(
			422,
			'state_in_use',
			`Cannot delete ${[...new Set(schedules.map((s) => `state "${s.state_name}"`))].join(', ')}: ${schedules.length === 1 ? `scheduled task "${schedules[0].name}" starts` : 'scheduled tasks start'} instances there; change the schedule${schedules.length === 1 ? "'s" : "s'"} start state first`,
			{
				schedules: schedules.map((s) => ({
					id: s.id,
					name: s.name,
					state_id: s.state_id,
					state_name: s.state_name
				}))
			}
		);
	}
}

/** Statements deleting a project's schedules (project deletion), with events. */
/**
 * Advances each schedule's `next_run_at` to its next future occurrence — the
 * same resume-from-now rule `updateSchedule` applies when a paused schedule is
 * re-enabled. Used by project unarchive so nothing fires a catch-up burst. A
 * schedule whose cron or timezone no longer evaluates is left alone rather
 * than failing the whole unarchive; the sweep already tolerates one.
 */
export function rearmScheduleQueries(
	db: Kysely<Database>,
	schedules: {
		id: string;
		cron: string;
		timezone: string;
		next_run_at: number;
		definition_revision: number;
	}[],
	now: number
): { queries: CompiledQuery[] } {
	const queries: CompiledQuery[] = [];
	for (const s of schedules) {
		let nextRunAt: number;
		try {
			nextRunAt = nextOccurrenceFromCron(s.cron, s.timezone, now);
		} catch (e) {
			console.error(`unarchive: schedule ${s.id} could not be re-armed:`, e);
			continue;
		}
		queries.push(
			db
				.updateTable('scheduled_task')
				.set({ next_run_at: nextRunAt, updated_at: now })
				.where('id', '=', s.id)
				.where('enabled', '=', 1)
				.where('next_run_at', '=', s.next_run_at)
				.where('definition_revision', '=', s.definition_revision)
				.compile()
		);
	}
	return { queries };
}

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
