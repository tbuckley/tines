/**
 * Creating a project schedule from a pack's suggestion (docs/packs.md). The
 * suggestion's `{{ inputs.* }}` render once, now, with the project's values;
 * the scheduler's own variables (`{{ date }}` …) are left for the scheduler.
 * The result is an ordinary, enabled project schedule.
 */
import {
	compilePackRecurrence,
	nextOccurrenceFromCron,
	renderPlaceholders,
	ScheduleInputError,
	type PackInputDecl,
	type PackSchedule
} from '@tines/shared';
import type { CompiledQuery, Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { ApiFail, type ActorContext } from '../core';
import { eventInsert } from '../events';
import { resolveInputText, type LoadedPack, type PackRenderContext } from '../pack-render';
import { resolveRecurrence, resolveTimezone } from '../schedules';
import type { ValueRow } from './values';

/**
 * A render context from values that may not be written yet (install, replace).
 * `workflowNames` resolves bound workflow ids to their name and start state.
 */
export async function renderContextFor(
	db: Kysely<Database>,
	pack: { id: string; name: string; projectName: string; inputs: Record<string, PackInputDecl> },
	values: ValueRow[],
	known: Map<string, { name: string; states: Map<string, string>; initialStateId: string }>
): Promise<PackRenderContext> {
	const loaded: LoadedPack = {
		id: pack.id,
		name: pack.name,
		projectName: pack.projectName,
		inputs: pack.inputs,
		values: new Map(values.map((v) => [v.name, v])),
		workflows: new Map(),
		secrets: new Set()
	};
	for (const [name, decl] of Object.entries(pack.inputs)) {
		if (decl.type !== 'workflow') continue;
		const v = loaded.values.get(name);
		if (!v?.workflow_id) {
			loaded.workflows.set(name, null);
			continue;
		}
		let wf = known.get(v.workflow_id);
		if (!wf) {
			const row = await db
				.selectFrom('workflow')
				.select(['id', 'name', 'initial_state_id'])
				.where('id', '=', v.workflow_id)
				.executeTakeFirst();
			if (row) {
				const states = await db
					.selectFrom('workflow_state')
					.select(['id', 'name'])
					.where('workflow_id', '=', row.id)
					.execute();
				wf = {
					name: row.name,
					initialStateId: row.initial_state_id,
					states: new Map(states.map((s) => [s.id, s.name]))
				};
			}
		}
		loaded.workflows.set(
			name,
			wf
				? {
						id: v.workflow_id,
						name: wf.name,
						stateName: wf.states.get(v.state_id ?? wf.initialStateId) ?? ''
					}
				: null
		);
	}
	return { packs: new Map([[pack.id, loaded]]), contributorId: null };
}

/** Inputs a suggestion's text needs that have no value. */
export function suggestionMissing(
	s: PackSchedule,
	ctx: PackRenderContext,
	packId: string
): string[] {
	const missing = new Set<string>();
	for (const text of [s.title, s.description])
		renderPlaceholders(text, (name) => {
			const r = resolveInputText(ctx, packId, name);
			if (!r.ok) missing.add(name);
			return r.ok ? r.value : undefined;
		});
	return [...missing];
}

export function scheduleFromSuggestionQueries(
	db: Kysely<Database>,
	actor: ActorContext,
	opts: {
		projectId: string;
		packId: string;
		packScheduleId: string;
		suggestion: PackSchedule;
		workflowId: string;
		stateId: string | null;
		timezone: unknown;
		ctx: PackRenderContext;
		/** Names already taken in the project (updated as schedules are added). */
		takenNames: Set<string>;
		now: number;
	}
): { id: string; name: string; queries: CompiledQuery[] } {
	const s = opts.suggestion;
	const missing = suggestionMissing(s, opts.ctx, opts.packId);
	if (missing.length)
		throw new ApiFail(
			422,
			'schedule_input_missing',
			`Suggested schedule "${s.name}" uses ${missing.map((m) => `"${m}"`).join(', ')}, which has no value yet`,
			{ schedule: s.key, inputs: missing }
		);
	const render = (text: string) =>
		renderPlaceholders(text, (name) => {
			const r = resolveInputText(opts.ctx, opts.packId, name);
			return r.ok ? r.value : undefined;
		}).text;
	let compiled;
	try {
		compiled = compilePackRecurrence(s.recurrence);
	} catch (e) {
		if (e instanceof ScheduleInputError) throw new ApiFail(422, 'invalid_recurrence', e.message);
		throw e;
	}
	const recurrence = resolveRecurrence(compiled);
	const timezone = resolveTimezone(opts.timezone);
	const nextRunAt = nextOccurrenceFromCron(recurrence.cron, timezone, opts.now);
	let name = s.name.slice(0, 200);
	for (let i = 2; opts.takenNames.has(name); i++) name = `${s.name.slice(0, 190)} (${i})`;
	opts.takenNames.add(name);
	const id = newId('sch');
	return {
		id,
		name,
		queries: [
			db
				.insertInto('scheduled_task')
				.values({
					id,
					project_id: opts.projectId,
					name,
					title_template: render(s.title),
					description_template: render(s.description),
					workflow_id: opts.workflowId,
					state_id: opts.stateId,
					cron: recurrence.cron,
					preset: recurrence.presetJson,
					timezone,
					require_all_closed: s.only_when_previous_closed ? 1 : 0,
					enabled: 1,
					next_run_at: nextRunAt,
					last_run_at: null,
					run_count: 0,
					created_at: opts.now,
					updated_at: opts.now,
					pack_schedule_id: opts.packScheduleId
				})
				.compile(),
			eventInsert(db, actor, {
				type: 'scheduled_task.created',
				projectId: opts.projectId,
				createdAt: opts.now,
				payload: { schedule_id: id, name, project_id: opts.projectId, pack_id: opts.packId }
			})
		]
	};
}

export async function takenScheduleNames(
	db: Kysely<Database>,
	projectId: string
): Promise<Set<string>> {
	const rows = await db
		.selectFrom('scheduled_task')
		.select('name')
		.where('project_id', '=', projectId)
		.execute();
	return new Set(rows.map((r) => r.name));
}
