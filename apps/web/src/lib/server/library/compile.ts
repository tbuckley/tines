import type { Kysely, CompiledQuery } from 'kysely';
import type { PackageAllocation } from '@tines/shared';
import type { Database } from '$lib/server/db';
import type { ActorContext } from '../api/core';
import type { QueryGuard } from '../api/query-guard';
import {
	workflowInsertQueries,
	type ResolvedDef,
	type ResolvedInheritance
} from '../api/workflows';
import { contextItemInsertQueries, validateContextCreateFields } from '../api/context';
import { labelInsertQueries } from '../api/labels';
import { scheduleInsertQueries, validateScheduleCreateFields } from '../api/schedules';
import { routingRuleInsertQueries } from '../api/routing';
import { scopeLabel, type ResolvedScope } from '../api/scope';
import type { ResolvedPackage } from './resolve';

/** All ordinary writes, fully guarded, with all shells before any inheritance. */
export function compilePackageObjects(
	db: Kysely<Database>,
	actor: ActorContext,
	plan: ResolvedPackage,
	allocation: PackageAllocation,
	guard: QueryGuard,
	now: number
): CompiledQuery[] {
	const id = (local: string) => allocation.records[local].id;
	const refs: ResolvedInheritance['refs'] = new Map();
	for (const workflow of plan.workflows)
		for (const state of workflow.states)
			refs.set(id(state.id), {
				id: id(state.id),
				name: state.name,
				workflowId: id(workflow.id),
				workflowName: workflow.name
			});
	const workflows = plan.workflows.map((workflow) => {
		const def: ResolvedDef = {
			initialStateId: id(workflow.initial_state_id),
			states: workflow.states.map((s, position) => ({
				id: id(s.id),
				name: s.name,
				category: s.category,
				position,
				isNew: true,
				inheritsFrom: s.inherits_from ? id(s.inherits_from.state_id) : null
			})),
			transitions: workflow.transitions.map((t) => ({
				id: id(t.id),
				name: t.name,
				from_state_id: id(t.from_state_id),
				to_state_id: id(t.to_state_id),
				requires: t.requires
			}))
		};
		const inh: ResolvedInheritance = {
			pointers: new Map(def.states.map((s) => [s.id, s.inheritsFrom ?? null])),
			changedIds: new Set(def.states.filter((s) => s.inheritsFrom).map((s) => s.id)),
			changes: def.states
				.filter((s) => s.inheritsFrom)
				.map((s) => {
					const base = refs.get(s.inheritsFrom!)!;
					return {
						workflow: workflow.name,
						state: s.name,
						from: null,
						to: `${base.workflowName} / ${base.name}`
					};
				}),
			refs
		};
		return {
			id: id(workflow.id),
			name: workflow.name,
			description: workflow.description,
			def,
			inh,
			now,
			guard,
			eventId: allocation.records[workflow.id].event_id!
		};
	});
	const queries = workflows.flatMap((options) =>
		workflowInsertQueries(db, actor, { ...options, phase: 'shells' })
	);
	queries.push(
		...workflows.flatMap((options) =>
			workflowInsertQueries(db, actor, { ...options, phase: 'inheritance' })
		)
	);
	const positions = new Map<string, number>();
	for (const item of plan.context) {
		const state = refs.get(id(item.state_id))!;
		const scope: ResolvedScope = {
			projectId: null,
			workflowStateId: state.id,
			labelId: null,
			issueId: null,
			projectName: null,
			stateName: state.name,
			labelName: null,
			labelColor: null,
			workflowId: state.workflowId,
			workflowName: state.workflowName,
			issueNumber: null,
			issueProjectName: null,
			issueProjectId: null,
			projectArchivedAt: null,
			issueProjectArchivedAt: null
		};
		const position = positions.get(state.id) ?? 0;
		positions.set(state.id, position + 1);
		queries.push(
			...contextItemInsertQueries(db, actor, {
				id: id(item.id),
				fields: validateContextCreateFields(item),
				scope,
				position,
				now,
				guard,
				eventId: allocation.records[item.id].event_id!,
				...(item.kind === 'skill' ? { fileIds: item.files.map((f) => id(f.id)) } : {})
			})
		);
	}
	for (const label of plan.labels) {
		const input = plan.inputs.find((i) => i.mode === 'create' && i.id === label.id)!;
		queries.push(
			...labelInsertQueries(
				db,
				actor,
				{ ...label, created_at: now, updated_at: now },
				{ guard, eventId: allocation.labels[input.input_id].event_id! }
			)
		);
	}
	for (const selected of plan.schedules) {
		const schedule = selected.definition;
		const prepared = validateScheduleCreateFields(
			{
				name: schedule.name,
				...(schedule.recurrence.kind === 'cron'
					? { cron: schedule.recurrence.cron }
					: { preset: schedule.recurrence.preset }),
				timezone: schedule.timezone,
				require_all_closed: schedule.require_all_closed
			},
			schedule.title_template,
			now
		);
		const state = schedule.start_state ? refs.get(id(schedule.start_state.state_id))! : null;
		queries.push(
			...scheduleInsertQueries(db, actor, {
				schedule: { id: id(schedule.id), ...prepared },
				projectId: selected.project_id,
				workflowId: id(schedule.workflow.workflow_id),
				stateId: state?.id ?? null,
				stateName: state?.name ?? null,
				titleTemplate: schedule.title_template,
				descriptionTemplate: schedule.description_template,
				now,
				guard,
				eventId: allocation.records[schedule.id].event_id!
			})
		);
	}
	for (const rule of plan.routing) {
		const state = refs.get(rule.state_id)!;
		const project = plan.inputs.find((i) => i.type === 'project' && i.id === rule.project_id);
		const label = scopeLabel({
			projectId: rule.project_id,
			projectName: project?.value ?? null,
			workflowStateId: state.id,
			stateName: state.name,
			workflowName: state.workflowName
		});
		queries.push(
			...routingRuleInsertQueries(db, actor, {
				id: rule.id,
				scope: { projectId: rule.project_id, workflowStateId: state.id, labelId: null },
				label,
				targets: [{ runner_id: '*', tier: rule.tier }],
				runnersById: new Map(),
				now,
				guard,
				eventId: allocation.records[rule.local_id].event_id!
			})
		);
	}
	return queries;
}
