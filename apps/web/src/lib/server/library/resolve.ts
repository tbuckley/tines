import {
	renderPackageFields,
	validatePackageChoices,
	type WorkflowPackageDocument,
	type WorkflowPackageChoices,
	type PackageAllocation,
	type ResolvedPackageInput,
	type PackageInputChoice,
	type Label,
	type ModelTier
} from '@tines/shared';
import { newId } from '$lib/server/db';
import { ApiFail } from '../api/core';
import { normalizeLabelName } from '../api/labels';
import { validateContextCreateFields } from '../api/context';
import { validateWorkflowCreateFields } from '../api/workflows';
import { validateScheduleCreateFields } from '../api/schedules';
import { resolveRoute, resolveTier, builtinTierModels } from '../supervisor/logic';
import { sqliteNoCase, type PackageDestination, type DestinationSelection } from './destination';

const fail = (code: string, message: string, id: string): never => {
	throw new ApiFail(422, code, message, { record_id: id });
};
const truncate = (value: string, length: number) =>
	value.slice(0, length).replace(/[\uD800-\uDBFF]$/, '');

/** Names are exact like ordinary workflow/schedule names. Equal content never implies reuse. */
export function resolvePackageNames(
	records: { id: string; name: string }[],
	chosen: Record<string, string>,
	occupied: string[]
): Record<string, string> {
	const reserved = new Set(occupied);
	const result: Record<string, string> = Object.create(null);
	// Reserve explicit choices first, so proposals cannot steal a later explicit choice.
	for (const record of records)
		if (Object.hasOwn(chosen, record.id)) {
			const name = chosen[record.id].trim();
			if (!name || name.length > 200)
				fail('invalid_name', 'Names must contain 1–200 characters', record.id);
			if (reserved.has(name))
				fail('name_collision', `Name "${name}" is already in use; choose another name`, record.id);
			result[record.id] = name;
			reserved.add(name);
		}
	for (const record of records)
		if (!Object.hasOwn(result, record.id)) {
			let name = record.name.trim();
			for (let attempt = 1; reserved.has(name); attempt++) {
				const suffix = attempt === 1 ? ' (imported)' : ` (imported ${attempt})`;
				name = truncate(record.name.trim(), 200 - suffix.length) + suffix;
			}
			result[record.id] = name;
			reserved.add(name);
		}
	return result;
}

export function allocatePackageObjects(document: WorkflowPackageDocument): PackageAllocation {
	const records: PackageAllocation['records'] = Object.create(null);
	const add = (id: string, prefix: string, event: boolean) => {
		records[id] = { id: newId(prefix), event_id: event ? newId('evt') : null };
	};
	for (const workflow of document.workflows) {
		add(workflow.id, 'wf', true);
		workflow.states.forEach((s) => add(s.id, 'wfs', false));
		workflow.transitions.forEach((t) => add(t.id, 'wft', false));
	}
	for (const item of document.context) {
		add(item.id, 'ctx', true);
		if (item.kind === 'skill') item.files.forEach((f) => add(f.id, 'ctf', false));
	}
	document.schedules.forEach((s) => add(s.id, 'sch', true));
	document.routing.forEach((r) => add(r.id, 'rul', true));
	// Allocate all potential label inputs once; unused allocations never authorize writes.
	const labels = Object.fromEntries(
		document.inputs
			.filter((i) => i.type === 'label')
			.map((i) => [i.id, { id: newId('lbl'), event_id: newId('evt') }])
	);
	return { records, labels };
}

export interface PackageRoutingResolution {
	local_id: string;
	id: string;
	project_id: string | null;
	state_id: string;
	tier: ModelTier;
	runner_rule_id: string;
	winning_rule_id: string;
	targets: {
		runner_id: string;
		name: string;
		type: string;
		status: string;
		model: string | null;
		config: string;
		supported: boolean;
	}[];
	warnings: string[];
}
export interface ResolvedPackage {
	choices: WorkflowPackageChoices;
	names: Record<string, string>;
	inputs: ResolvedPackageInput[];
	labels: Label[];
	workflows: WorkflowPackageDocument['workflows'];
	context: WorkflowPackageDocument['context'];
	schedules: {
		local_id: string;
		project_id: string;
		definition: WorkflowPackageDocument['schedules'][number];
	}[];
	routing: PackageRoutingResolution[];
	patches: ReturnType<typeof renderPackageFields>;
	selection: DestinationSelection;
	skipped: { kind: 'schedule' | 'routing'; local_id: string }[];
}

/** Pure resolution from a single coherent destination snapshot; no reads or writes. */
export function resolvePackageDestination(
	document: WorkflowPackageDocument,
	rawChoices: unknown,
	destination: PackageDestination,
	allocation: PackageAllocation,
	now: number
): ResolvedPackage {
	const choices = validatePackageChoices(rawChoices, document);
	const selectedScheduleIds = choices.schedule_ids ?? [];
	const selectedRouting = choices.routing ?? {};
	const selectedSchedules = document.schedules.filter((s) => selectedScheduleIds.includes(s.id));
	const selectedTiers = document.routing.filter((r) => Object.hasOwn(selectedRouting, r.id));
	const activeTargets = new Set(selectedSchedules.map((s) => s.id));
	const scheduleIds = new Set(document.schedules.map((s) => s.id));
	const textUses = document.text_uses.filter(
		(u) => !scheduleIds.has(u.target.record_id) || activeTargets.has(u.target.record_id)
	);
	const needed = new Set(textUses.map((u) => u.input_id));
	selectedSchedules.forEach((s) => needed.add(s.project.input_id));
	selectedTiers.forEach((r) => {
		if (r.scope.project) needed.add(r.scope.project.input_id);
	});
	const inputs: ResolvedPackageInput[] = [];
	const normalizedInputs: Record<string, PackageInputChoice> = Object.create(null);
	const labels: Label[] = [];
	const newLabelNames = new Set<string>();
	for (const input of document.inputs) {
		const choice = choices.inputs?.[input.id];
		const base = { input_id: input.id, type: input.type, id: null, color: null };
		// A project used only by omitted automation must not make project-free install impossible.
		if (!needed.has(input.id) && (input.type === 'project' || !input.required) && !choice) {
			inputs.push({ ...base, mode: 'unused', value: '' });
			continue;
		}
		if (input.type === 'text') {
			const value = choice && 'value' in choice ? choice.value : (input.default ?? '');
			if (input.required && !value.trim())
				fail('missing_input', `Input "${input.label}" is required`, input.id);
			normalizedInputs[input.id] = { value };
			inputs.push({ ...base, mode: 'value', value });
			continue;
		}
		if (input.type === 'label' && choice && 'mode' in choice && choice.mode === 'create') {
			const name = normalizeLabelName(choice.name);
			if (
				destination.labels.some((l) => sqliteNoCase(l.name) === sqliteNoCase(name)) ||
				newLabelNames.has(sqliteNoCase(name))
			)
				fail(
					'name_collision',
					`Label "${name}" already exists or is created by another input; choose reuse or another name`,
					input.id
				);
			newLabelNames.add(sqliteNoCase(name));
			const id = allocation.labels[input.id].id;
			labels.push({
				id,
				name,
				color: choice.color,
				description: '',
				created_at: now,
				updated_at: now
			});
			normalizedInputs[input.id] = { mode: 'create', name, color: choice.color };
			inputs.push({ ...base, mode: 'create', value: name, color: choice.color, id });
			continue;
		}
		const collection =
			input.type === 'workflow'
				? destination.workflows
				: input.type === 'project'
					? destination.projects
					: destination.labels;
		const explicitId = choice && 'mode' in choice && choice.mode === 'reuse' ? choice.id : null;
		const matches = explicitId
			? collection.filter((o) => o.id === explicitId)
			: input.default === null
				? []
				: collection.filter((o) =>
						input.type === 'label'
							? sqliteNoCase(o.name) === sqliteNoCase(input.default!)
							: o.name === input.default
					);
		if (matches.length !== 1) {
			if (!explicitId && !input.required && !needed.has(input.id)) {
				inputs.push({ ...base, mode: 'unused', value: '' });
				continue;
			}
			if (explicitId)
				throw new ApiFail(404, 'not_found', 'Destination input not found', { input_id: input.id });
			fail(
				matches.length > 1 ? 'ambiguous_input' : 'missing_input',
				`Choose a destination ${input.type} for "${input.label}"${matches.length > 1 ? '; the default name is ambiguous' : ''}`,
				input.id
			);
		}
		const match = matches[0];
		if ('archived_at' in match && match.archived_at !== null)
			fail('project_archived', `Project "${match.name}" is archived`, input.id);
		if (input.type === 'workflow') {
			const workflow = destination.workflows.find((w) => w.id === match.id)!;
			const missing = (input.required_states ?? []).filter(
				(name) => !workflow.states.some((s) => s.name === name)
			);
			if (missing.length)
				fail(
					'missing_required_states',
					`Workflow "${match.name}" lacks required states: ${missing.join(', ')}`,
					input.id
				);
		}
		normalizedInputs[input.id] = { mode: 'reuse', id: match.id };
		inputs.push({
			...base,
			mode: 'reuse',
			id: match.id,
			value: match.name,
			color: 'color' in match ? match.color : null
		});
	}
	const values = Object.fromEntries(inputs.map((i) => [i.input_id, i.value]));
	const patches = renderPackageFields({ ...document, text_uses: textUses }, values);
	const rendered = structuredClone(document);
	const records = new Map<string, Record<string, unknown>>();
	for (const record of [...rendered.workflows, ...rendered.context, ...rendered.schedules])
		records.set(record.id, record as unknown as Record<string, unknown>);
	for (const context of rendered.context)
		if (context.kind === 'skill')
			for (const file of context.files)
				records.set(file.id, file as unknown as Record<string, unknown>);
	for (const patch of patches) records.get(patch.record_id)![patch.field] = patch.rendered;
	const names = resolvePackageNames(
		document.workflows,
		choices.workflow_names ?? {},
		destination.workflows.map((w) => w.name)
	);
	for (const workflow of rendered.workflows) {
		workflow.name = names[workflow.id];
		const stateNames = new Map(workflow.states.map((s) => [s.id, s.name]));
		validateWorkflowCreateFields({
			name: workflow.name,
			description: workflow.description,
			initial_state: stateNames.get(workflow.initial_state_id)!,
			states: workflow.states.map((s) => ({ name: s.name, category: s.category })),
			transitions: workflow.transitions.map((t) => ({
				name: t.name,
				from: stateNames.get(t.from_state_id)!,
				to: stateNames.get(t.to_state_id)!,
				requires: t.requires
			}))
		});
	}
	for (const item of rendered.context) validateContextCreateFields(item);
	const schedules: ResolvedPackage['schedules'] = [];
	const scheduleNames: Record<string, string> = Object.create(null);
	const projectFor = (id: string) => {
		const input = inputs.find((i) => i.input_id === id);
		if (!input || input.type !== 'project' || !input.id)
			fail('missing_input', 'Selected configuration requires a destination project', id);
		return input!.id!;
	};
	const projectIds = [...new Set(selectedSchedules.map((s) => projectFor(s.project.input_id)))];
	for (const projectId of projectIds) {
		const group = selectedSchedules.filter((s) => projectFor(s.project.input_id) === projectId);
		Object.assign(
			scheduleNames,
			resolvePackageNames(
				group,
				choices.schedule_names ?? {},
				destination.schedules.filter((s) => s.project_id === projectId).map((s) => s.name)
			)
		);
	}
	for (const schedule of rendered.schedules.filter((s) => selectedScheduleIds.includes(s.id))) {
		schedule.name = scheduleNames[schedule.id];
		validateScheduleCreateFields(
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
		schedules.push({
			local_id: schedule.id,
			project_id: projectFor(schedule.project.input_id),
			definition: schedule
		});
	}
	const prospectiveRules = selectedTiers.map((r) => ({
		id: allocation.records[r.id].id,
		project_id: r.scope.project ? projectFor(r.scope.project.input_id) : null,
		workflow_state_id: allocation.records[r.scope.state_id].id,
		label_id: null,
		targets: [{ runner_id: '*', tier: selectedRouting[r.id] }]
	}));
	const scopes = new Set<string>();
	for (const rule of prospectiveRules) {
		const key = JSON.stringify([rule.project_id, rule.workflow_state_id]);
		if (scopes.has(key))
			fail(
				'scope_collision',
				'Selected tier preferences target the same destination scope',
				rule.id
			);
		scopes.add(key);
	}
	const existingRules = destination.rules.map((r) => ({ ...r, targets: JSON.parse(r.targets) }));
	const routing: PackageRoutingResolution[] = selectedTiers.map((preference, i) => {
		const rule = prospectiveRules[i];
		const state = rendered.workflows
			.flatMap((w) => w.states)
			.find((s) => s.id === preference.scope.state_id)!;
		if (state.category !== 'active')
			fail('invalid_routing_state', 'Tier preferences require an active state', preference.id);
		const route = resolveRoute(
			{ project_id: rule.project_id ?? '', state_id: rule.workflow_state_id, label_ids: [] },
			[...existingRules, ...prospectiveRules]
		);
		if (route.failure || !route.runnerRule || !route.rule)
			fail(
				'routing_unavailable',
				`Destination routing cannot resolve this tier: ${route.failure}`,
				preference.id
			);
		const targets = route.targets
			.map((target) => {
				const runner = destination.runners.find((r) => r.id === target.runner_id);
				if (!runner) return null;
				const supported =
					runner.status === 'active' &&
					builtinTierModels(runner) !== null &&
					(runner.type === 'local' || runner.has_api_key === 1);
				return {
					runner_id: runner.id,
					name: runner.name,
					type: runner.type,
					status: runner.status,
					model: resolveTier(runner, target.tier ?? null).model,
					config: runner.config,
					supported
				};
			})
			.filter((r): r is NonNullable<typeof r> => r !== null);
		if (!targets.some((t) => t.supported))
			fail(
				'routing_unavailable',
				'No active supported destination runner supplies this tier',
				preference.id
			);
		return {
			local_id: preference.id,
			id: rule.id,
			project_id: rule.project_id,
			state_id: rule.workflow_state_id,
			tier: selectedRouting[preference.id],
			runner_rule_id: route.runnerRule!.id,
			winning_rule_id: route.rule!.id,
			targets,
			warnings: [
				'Runner online status, available slots, backoff and spending limits are advisory at install time.',
				...(rule.project_id === null
					? ['Future project or label rules can override this workflow-only preference.']
					: ['Future label rules can override this preference.'])
			]
		};
	});
	const routingScopes = prospectiveRules.map((r) => ({
		project_id: r.project_id,
		state_id: r.workflow_state_id
	}));
	const applicableRules = destination.rules.filter(
		(r) =>
			r.label_id === null &&
			routingScopes.some(
				(s) =>
					(r.project_id === null || r.project_id === s.project_id) &&
					(r.workflow_state_id === null || r.workflow_state_id === s.state_id)
			)
	);
	const runnerIds = [
		...new Set(
			applicableRules
				.flatMap((r) => (JSON.parse(r.targets) as { runner_id: string }[]).map((t) => t.runner_id))
				.filter((id) => id !== '*')
		)
	];
	const selection: DestinationSelection = {
		workflow_ids: inputs.filter((i) => i.type === 'workflow' && i.id).map((i) => i.id!),
		workflow_names: Object.values(names),
		project_ids: [...new Set(inputs.filter((i) => i.type === 'project' && i.id).map((i) => i.id!))],
		label_ids: inputs.filter((i) => i.type === 'label' && i.mode === 'reuse').map((i) => i.id!),
		label_names: labels.map((l) => l.name),
		schedules: schedules.map((s) => ({ project_id: s.project_id, name: s.definition.name })),
		routing_scopes: routingScopes,
		runner_ids: runnerIds
	};
	return {
		choices: {
			workflow_names: names,
			schedule_names: scheduleNames,
			inputs: normalizedInputs,
			schedule_ids: selectedSchedules.map((s) => s.id),
			routing: selectedRouting
		},
		names,
		inputs,
		labels,
		workflows: rendered.workflows,
		context: rendered.context,
		schedules,
		routing,
		patches,
		selection,
		skipped: [
			...document.schedules
				.filter((s) => !selectedScheduleIds.includes(s.id))
				.map((s) => ({ kind: 'schedule' as const, local_id: s.id })),
			...document.routing
				.filter((r) => !Object.hasOwn(selectedRouting, r.id))
				.map((r) => ({ kind: 'routing' as const, local_id: r.id }))
		]
	};
}
