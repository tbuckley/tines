import {
	withLibraryDocumentDigest,
	type WorkflowPackageDocument,
	type ExportWorkflowPackageOptions,
	type PackageContext,
	type PackageInput,
	type PackageSchedule
} from '@tines/shared';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { ApiFail, notFound } from '../api/core';
import { loadWorkflows } from '../api/workflows';
import { contextItemQuery, loadFiles, isJournal } from '../api/context';
import { resolveRecurrence } from '../api/schedules';

/** Export the chosen workflow and its exact-state context without writes. */
export async function exportWorkflowPackage(
	db: Kysely<Database>,
	userId: string,
	workflowId: string,
	options: ExportWorkflowPackageOptions = {},
	internal: { exportedAt?: number } = {}
): Promise<WorkflowPackageDocument> {
	if (
		internal.exportedAt !== undefined &&
		(!Number.isSafeInteger(internal.exportedAt) || internal.exportedAt < 0)
	)
		throw new Error('Internal exportedAt must be a non-negative safe integer');
	if (
		!options ||
		typeof options !== 'object' ||
		Array.isArray(options) ||
		Object.keys(options).some(
			(k) => !['source_project_id', 'schedule_ids', 'tiers', 'authoring'].includes(k)
		)
	)
		throw new ApiFail(422, 'invalid_export_options', 'Unknown workflow export selection');
	if (options.source_project_id !== undefined && typeof options.source_project_id !== 'string')
		throw new ApiFail(422, 'invalid_export_options', 'source_project_id must be a project ID');
	const scheduleIds = options.schedule_ids ?? [];
	const tiers = options.tiers ?? [];
	if (
		!Array.isArray(scheduleIds) ||
		scheduleIds.some((id) => typeof id !== 'string') ||
		new Set(scheduleIds).size !== scheduleIds.length ||
		!Array.isArray(tiers)
	)
		throw new ApiFail(
			422,
			'invalid_export_options',
			'Schedule IDs must be unique strings and tiers must be an array'
		);
	for (const tier of tiers)
		if (
			!tier ||
			typeof tier !== 'object' ||
			Object.keys(tier).some((k) => !['state_id', 'tier', 'project_scoped'].includes(k)) ||
			typeof tier.state_id !== 'string' ||
			(tier.project_scoped !== undefined && typeof tier.project_scoped !== 'boolean')
		)
			throw new ApiFail(422, 'invalid_export_options', 'Invalid tier selection');
	const available = await loadWorkflows(db, userId);
	const main = available.find((w) => w.id === workflowId);
	if (!main) throw notFound();
	const workflows = [main];
	const workflowIds = new Map(workflows.map((w, i) => [w.id, `workflow:${i + 1}`]));
	let stateCount = 0;
	const states = workflows.flatMap((w) =>
		[...w.states].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
	);
	const stateIds = new Map(states.map((state) => [state.id, `state:${++stateCount}`]));
	const contextRows = (
		await contextItemQuery(db, userId)
			.where('context_item.project_id', 'is', null)
			.where('context_item.label_id', 'is', null)
			.where('context_item.issue_id', 'is', null)
			.where('context_item.workflow_state_id', 'is not', null)
			.where('context_item.kind', 'not in', ['artifact', 'env'])
			.orderBy('context_item.position')
			.orderBy('context_item.created_at')
			.orderBy('context_item.id')
			.execute()
	).filter((row) => stateIds.has(row.workflow_state_id!) && !isJournal(row));
	const files = await loadFiles(
		db,
		contextRows.filter((row) => row.kind === 'skill').map((row) => row.id)
	);
	let fileCount = 0;
	const context: PackageContext[] = contextRows.map((row, i) => {
		const common = {
			id: `context:${i + 1}`,
			state_id: stateIds.get(row.workflow_state_id!)!,
			name: row.name,
			description: row.description
		};
		if (row.kind === 'prompt') return { ...common, kind: 'prompt', body: row.body ?? '' };
		if (row.kind === 'skill')
			return {
				...common,
				kind: 'skill',
				files: (files.get(row.id) ?? []).map((file) => ({ id: `file:${++fileCount}`, ...file }))
			};
		return {
			...common,
			kind: 'repo',
			repo_url: row.repo_url ?? '',
			repo_branch: row.repo_branch,
			repo_dir: row.repo_dir
		};
	});
	const project = options.source_project_id
		? await db
				.selectFrom('project')
				.select(['id', 'name'])
				.where('id', '=', options.source_project_id)
				.where('user_id', '=', userId)
				.executeTakeFirst()
		: undefined;
	if (options.source_project_id && !project) throw notFound();
	if ((scheduleIds.length || tiers.some((t) => t.project_scoped)) && !project)
		throw new ApiFail(
			422,
			'source_project_required',
			'Selected project-bound configuration requires an explicit source project'
		);
	const selectedSchedules = project
		? await db
				.selectFrom('scheduled_task')
				.selectAll()
				.where('project_id', '=', project.id)
				.orderBy('created_at')
				.orderBy('id')
				.execute()
		: [];
	if (
		scheduleIds.some(
			(id) => !selectedSchedules.some((s) => s.id === id && workflowIds.has(s.workflow_id))
		)
	)
		throw new ApiFail(
			422,
			'invalid_schedule_selection',
			'Selected schedule must belong to the explicit source project and a bundled workflow'
		);
	const authoring = options.authoring ?? { inputs: [], text_uses: [] };
	if (
		!authoring ||
		typeof authoring !== 'object' ||
		Object.keys(authoring).some((k) => !['inputs', 'text_uses'].includes(k)) ||
		!Array.isArray(authoring.inputs) ||
		!Array.isArray(authoring.text_uses)
	)
		throw new ApiFail(
			422,
			'invalid_authoring',
			'authoring must contain inputs and text_uses arrays'
		);
	const inputs: PackageInput[] = structuredClone(authoring.inputs);
	const projectBound = scheduleIds.length > 0 || tiers.some((t) => t.project_scoped);
	const projectInputId = 'input:destination_project';
	if (projectBound) {
		if (
			inputs.some((input) => input?.id === projectInputId || input?.key === 'destination_project')
		)
			throw new ApiFail(
				422,
				'reserved_project_input',
				'destination_project is automatically declared for selected project-bound configuration'
			);
		inputs.push({
			id: projectInputId,
			key: 'destination_project',
			type: 'project',
			label: 'Destination project',
			description: 'Project for the selected schedules and project-scoped tier preferences',
			required: true,
			default: null
		});
	}
	const schedules: PackageSchedule[] = selectedSchedules
		.filter((s) => scheduleIds.includes(s.id))
		.map((s, i) => {
			const recurrence = resolveRecurrence(
				s.preset ? { preset: JSON.parse(s.preset) } : { cron: s.cron }
			);
			return {
				id: `schedule:${i + 1}`,
				workflow: { kind: 'bundled_workflow', workflow_id: workflowIds.get(s.workflow_id)! },
				project: { kind: 'input_project', input_id: projectInputId },
				name: s.name,
				title_template: s.title_template,
				description_template: s.description_template,
				recurrence: recurrence.preset
					? { kind: 'preset', preset: recurrence.preset }
					: { kind: 'cron', cron: recurrence.cron },
				timezone: s.timezone,
				require_all_closed: s.require_all_closed === 1,
				start_state: s.state_id
					? { kind: 'bundled_state', state_id: stateIds.get(s.state_id)! }
					: null
			};
		});
	let transitionCount = 0;
	return withLibraryDocumentDigest({
		format: 'tines.library',
		version: 3,
		profile: 'workflow',
		exported_at: internal.exportedAt ?? Date.now(),
		digest: '',
		main_workflow_id: 'workflow:1',
		workflows: workflows.map((w) => ({
			id: workflowIds.get(w.id)!,
			name: w.name,
			description: w.description,
			initial_state_id: stateIds.get(w.initial_state_id)!,
			states: [...w.states]
				.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
				.map((s) => ({
					id: stateIds.get(s.id)!,
					name: s.name,
					category: s.category,
					inherits_from: null
				})),
			transitions: [...w.transitions]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((t) => ({
					id: `transition:${++transitionCount}`,
					name: t.name,
					from_state_id: stateIds.get(t.from_state_id)!,
					to_state_id: stateIds.get(t.to_state_id)!,
					requires: t.requires ?? []
				}))
		})),
		context,
		inputs,
		text_uses: structuredClone(authoring.text_uses),
		schedules,
		routing: tiers.map((tier, i) => {
			const stateId = stateIds.get(tier.state_id);
			if (!stateId)
				throw new ApiFail(
					422,
					'invalid_tier_selection',
					'Tier selection must identify a bundled state'
				);
			return {
				id: `routing:${i + 1}`,
				scope: {
					state_id: stateId,
					...(tier.project_scoped
						? { project: { kind: 'input_project' as const, input_id: projectInputId } }
						: {})
				},
				tier: tier.tier
			};
		})
	});
}
