import {
	parseLibraryV3Document,
	LibraryValidationError,
	type ImportLibraryRequest,
	type ImportLibraryResponse,
	type ImportPlanEntry,
	type LibraryV3Document,
	type LibraryV3Workflow,
	type LibraryV3Context,
	type CreateWorkflowRequest,
	type CreateContextItemRequest,
	type WorkflowResponse,
	type ImportAction
} from '@tines/shared';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { ApiFail, type ActorContext } from './core';
import {
	createWorkflow,
	updateWorkflow,
	loadWorkflows,
	validateWorkflowCreateFields,
	workflowAsRequest,
	workflowFingerprint,
	resolveInheritance,
	type ResolvedDef
} from './workflows';
import { createProject, validateProjectFields } from './projects';
import type { DispatchEffects } from '$lib/server/dispatch-effects';
import { createLabel, normalizeLabelName } from './labels';
import {
	contextItemQuery,
	createContextItem,
	updateContextItem,
	validateContextCreateFields
} from './context';
import { projectArchivedError } from './archive';

type WorkflowStep = {
	entry: ImportPlanEntry;
	source: LibraryV3Workflow;
	definition: CreateWorkflowRequest;
	existing?: WorkflowResponse;
};
type Step = { entry: ImportPlanEntry };
interface V3Plan {
	steps: Step[];
	document: LibraryV3Document;
	workflows: WorkflowStep[];
	projects: Map<string, string>;
	labels: Map<string, string>;
	states: Map<string, string>;
	workflowIds: Map<string, string>;
	context: Map<string, CreateContextItemRequest>;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const runnable = (entry: ImportPlanEntry) =>
	entry.action === 'create' || entry.action === 'overwrite';
const contextKey = (
	kind: string,
	name: string,
	project: string | null,
	state: string | null,
	label: string | null
) => JSON.stringify([kind, name, project, state, label]);

/** Whole-library imports are best effort. Identity is local-ID → destination-ID, never display name. */
export async function planLibraryV3Import(
	db: Kysely<Database>,
	userId: string,
	request: ImportLibraryRequest
): Promise<V3Plan> {
	let parsed;
	try {
		parsed = await parseLibraryV3Document(JSON.stringify(request.document));
	} catch (error) {
		if (!(error instanceof LibraryValidationError)) throw error;
		throw new ApiFail(422, 'invalid_library', message(error), { diagnostics: error.diagnostics });
	}
	if (parsed.profile !== 'library')
		throw new ApiFail(
			422,
			'wrong_library_profile',
			'Workflow packages use the prepare/install flow, not whole-library import'
		);
	// Normalize a private working copy only after validating the signed file bytes.
	const document = structuredClone(parsed);
	for (const workflow of document.workflows) {
		workflow.name = workflow.name.trim();
		for (const state of workflow.states) state.name = state.name.trim();
		for (const transition of workflow.transitions) transition.name = transition.name.trim();
	}
	for (const project of document.projects) project.name = project.name.trim();
	for (const label of document.labels) label.name = label.name.trim();
	for (const item of document.context) item.name = item.name.trim();
	const [available, projectRows, labelRows, contextRows] = await Promise.all([
		loadWorkflows(db, userId),
		db.selectFrom('project').selectAll().where('user_id', '=', userId).execute(),
		db.selectFrom('label').selectAll().where('user_id', '=', userId).execute(),
		contextItemQuery(db, userId).where('context_item.issue_id', 'is', null).execute()
	]);
	const targets = request.workflow_targets ?? {};
	if (
		typeof targets !== 'object' ||
		Array.isArray(targets) ||
		Object.keys(targets).some((id) => !document.workflows.some((w) => w.id === id))
	)
		throw new ApiFail(
			422,
			'invalid_workflow_targets',
			'workflow_targets must map document-local workflow IDs'
		);
	const plan: V3Plan = {
		steps: [],
		document,
		workflows: [],
		projects: new Map(),
		labels: new Map(),
		states: new Map(),
		workflowIds: new Map(),
		context: new Map()
	};
	const entry = (
		section: ImportPlanEntry['section'],
		id: string,
		name: string,
		action: ImportAction,
		reason?: string
	): ImportPlanEntry => {
		const result = {
			section,
			local_id: id,
			ref: `${section} "${name}" [${id}]`,
			action,
			...(reason ? { reason } : {})
		};
		plan.steps.push({ entry: result });
		return result;
	};
	const usedTargets = new Set<string>();
	const sourceCounts = new Map<string, number>();
	for (const w of document.workflows) sourceCounts.set(w.name, (sourceCounts.get(w.name) ?? 0) + 1);
	for (const source of document.workflows) {
		const report = entry('workflow', source.id, source.name, 'create');
		try {
			const choice = targets[source.id];
			let existing: WorkflowResponse | undefined;
			let name = source.name;
			const candidates = available.filter((w) => w.name === source.name);
			if (Object.hasOwn(targets, source.id)) {
				if (!choice || typeof choice !== 'object' || Array.isArray(choice))
					throw Error('Invalid workflow target');
				if (
					choice.kind === 'target' &&
					Object.keys(choice).every((k) => ['kind', 'workflow_id'].includes(k))
				) {
					existing = available.find((w) => w.id === choice.workflow_id && !w.is_system);
					if (!existing)
						throw Error('Target workflow is missing, belongs to another account, or is read-only');
					name = existing.name;
				} else if (
					choice.kind === 'create' &&
					Object.keys(choice).every((k) => ['kind', 'name'].includes(k)) &&
					typeof choice.name === 'string'
				) {
					name = choice.name.trim();
					if (
						available.some((w) => w.name === name) ||
						plan.workflows.some((w) => !w.existing && w.definition.name === name)
					)
						throw Error('Create name already exists; choose an unused name or an explicit target');
				} else
					throw Error(
						'Invalid workflow target: choose target with workflow_id or create with name'
					);
			} else if (candidates.length) {
				if (
					candidates.length !== 1 ||
					candidates[0].is_system ||
					sourceCounts.get(source.name)! > 1
				) {
					report.action = 'refuse';
					report.reason =
						'Ambiguous or system workflow collision; choose an owned target ID or an unused create name for this local ID';
					continue;
				}
				existing = candidates[0];
			}
			if (existing) {
				if (usedTargets.has(existing.id))
					throw new ApiFail(
						422,
						'many_to_one_workflow_targets',
						'Two local workflows cannot target the same destination workflow'
					);
				usedTargets.add(existing.id);
				report.target_id = existing.id;
				plan.workflowIds.set(source.id, existing.id);
				for (const state of source.states) {
					const stored = existing.states.find((s) => s.name === state.name);
					if (stored) plan.states.set(state.id, stored.id);
				}
			}
			const names = new Map(source.states.map((s) => [s.id, s.name]));
			const definition: CreateWorkflowRequest = {
				name,
				description: source.description,
				initial_state: names.get(source.initial_state_id)!,
				states: source.states.map((s) => ({ name: s.name, category: s.category })),
				transitions: source.transitions.map((t) => ({
					name: t.name,
					from: names.get(t.from_state_id)!,
					to: names.get(t.to_state_id)!,
					requires: t.requires
				}))
			};
			const fields = validateWorkflowCreateFields(definition);
			definition.name = fields.name;
			definition.description = fields.description;
			const step = { entry: report, source, definition, existing };
			plan.workflows.push(step);
			if (
				existing &&
				workflowFingerprint(workflowAsRequest(existing)) !== workflowFingerprint(definition)
			) {
				report.action = 'refuse';
				report.reason =
					'Target has a different structure; existing states remain available to scoped context';
			} else if (!existing) {
				for (const state of source.states) plan.states.set(state.id, `library-plan:${state.id}`);
			}
		} catch (error) {
			if (error instanceof ApiFail && error.code === 'many_to_one_workflow_targets') throw error;
			report.action = 'error';
			report.reason = message(error);
		}
	}
	const standard = available.find((w) => w.is_system && w.name === 'Standard');
	const stateId = (ref: NonNullable<LibraryV3Workflow['states'][number]['inherits_from']>) =>
		ref.kind === 'bundled_state'
			? plan.states.get(ref.state_id)
			: standard?.states.find((s) => s.name === ref.state_name)?.id;
	// Pointers compare after every source has a destination identity. Refused overwrites retain stored states.
	for (const step of plan.workflows) {
		if (step.entry.action === 'refuse' || !step.existing) continue;
		const different = step.source.states.some(
			(s) =>
				(s.inherits_from ? stateId(s.inherits_from) : null) !==
				step.existing!.states.find((x) => x.name === s.name)?.inherits_from
		);
		step.entry.action = different
			? request.on_collision === 'overwrite' && !step.existing.is_system
				? 'overwrite'
				: 'refuse'
			: 'skip';
		step.entry.reason = different
			? step.entry.action === 'overwrite'
				? 'Updating inheritance pointers on the selected target'
				: 'Inheritance pointers differ; overwrite is required on an editable target'
			: 'An identical workflow already exists';
	}
	// Remove unavailable creates to a fixpoint; then validate the combined prospective graph against stored descendants.
	for (let changed = true; changed;) {
		changed = false;
		for (const step of plan.workflows.filter((s) => runnable(s.entry))) {
			if (step.source.states.some((s) => s.inherits_from && !stateId(s.inherits_from))) {
				step.entry.action = 'refuse';
				step.entry.reason = 'An inheritance dependency is unavailable after planning';
				if (!step.existing) for (const state of step.source.states) plan.states.delete(state.id);
				changed = true;
			}
		}
		if (changed) continue;
		const active = plan.workflows.filter((s) => runnable(s.entry));
		const graph: ResolvedDef['states'] = active.flatMap((step) =>
			step.source.states.map((state, position) => ({
				id: plan.states.get(state.id)!,
				name: state.name,
				category: state.category,
				position,
				isNew: !step.existing,
				inheritsFrom: state.inherits_from ? stateId(state.inherits_from)! : null
			}))
		);
		try {
			await resolveInheritance(
				db,
				userId,
				{ id: null, name: 'Library import' },
				graph,
				active.flatMap((s) => s.existing?.states ?? [])
			);
		} catch (error) {
			if (!(error instanceof ApiFail)) throw error;
			const owners = new Map(
				active.flatMap((step) =>
					step.source.states.map((state) => [plan.states.get(state.id)!, step] as const)
				)
			);
			const chain = Array.isArray(error.details?.chain) ? (error.details.chain as string[]) : [];
			let affected = chain.map((id) => owners.get(id)).find(Boolean);
			let cursor = typeof error.details?.state_id === 'string' ? error.details.state_id : null;
			const stored = new Map(available.flatMap((w) => w.states).map((state) => [state.id, state]));
			const seen = new Set<string>();
			while (!affected && cursor && !seen.has(cursor)) {
				seen.add(cursor);
				affected = owners.get(cursor);
				cursor = stored.get(cursor)?.inherits_from ?? null;
			}
			if (!affected) throw error;
			affected.entry.action = 'refuse';
			affected.entry.reason = message(error);
			if (!affected.existing)
				for (const state of affected.source.states) plan.states.delete(state.id);
			changed = true;
		}
	}
	for (const project of document.projects) {
		const report = entry('project', project.id, project.name, 'create');
		try {
			validateProjectFields(project);
			const existing = projectRows.find((p) => p.name === project.name);
			if (existing) {
				plan.projects.set(project.id, existing.id);
				report.action = 'skip';
				report.target_id = existing.id;
				report.reason = 'A project with this name already exists; its default is unchanged';
			} else if (request.create_projects === false) {
				report.action = 'skip';
				report.reason = 'Creating projects is disabled';
			} else plan.projects.set(project.id, `library-plan:${project.id}`);
			const ref = project.default_workflow;
			if (
				report.action === 'create' &&
				ref &&
				!(ref.kind === 'system_workflow'
					? standard
					: plan.workflowIds.has(ref.workflow_id) ||
						plan.workflows.some(
							(w) => w.source.id === ref.workflow_id && w.entry.action === 'create'
						))
			)
				report.reason =
					'Default workflow is unavailable after planning; project keeps the system default';
		} catch (error) {
			report.action = 'error';
			report.reason = message(error);
		}
	}
	for (const label of document.labels) {
		const report = entry('label', label.id, label.name, 'create');
		try {
			const name = normalizeLabelName(label.name);
			const existing = labelRows.find((l) => l.name.toLowerCase() === name.toLowerCase());
			plan.labels.set(label.id, existing?.id ?? `library-plan:${label.id}`);
			if (existing) {
				report.action = 'skip';
				report.target_id = existing.id;
				report.reason = 'A label with this name already exists; its color is unchanged';
			}
		} catch (error) {
			report.action = 'error';
			report.reason = message(error);
		}
	}
	const existingContext = new Map(
		contextRows.map((c) => [
			contextKey(c.kind, c.name, c.project_id, c.workflow_state_id, c.label_id),
			c
		])
	);
	const seenContext = new Set<string>();
	for (const source of document.context) {
		const report = entry('context', source.id, source.name, 'create');
		if (source.journal && request.include_journals === false) {
			report.action = 'skip';
			report.reason = 'Journals are excluded';
			continue;
		}
		try {
			const payload = contextPayload(source);
			validateContextCreateFields(payload);
			const project = source.scope.project_id ? plan.projects.get(source.scope.project_id) : null;
			const state = source.scope.state ? stateId(source.scope.state) : null;
			const label = source.scope.label_id ? plan.labels.get(source.scope.label_id) : null;
			if (project === undefined || state === undefined || label === undefined) {
				report.action = 'skip';
				report.reason = 'A declared scope is unavailable after planning';
				continue;
			}
			const key = contextKey(source.kind, source.name, project, state, label);
			if (seenContext.has(key))
				throw Error('Multiple context records map to the same destination kind/name/scope');
			seenContext.add(key);
			const existing = existingContext.get(key);
			if (existing) {
				report.target_id = existing.id;
				report.action = request.on_collision === 'overwrite' ? 'overwrite' : 'skip';
				report.reason = 'An item with this name and scope already exists';
			}
			const projectRow = projectRows.find((p) => p.id === project);
			if (runnable(report) && projectRow?.archived_at != null)
				throw projectArchivedError(projectRow);
			plan.context.set(source.id, payload);
		} catch (error) {
			report.action = 'error';
			report.reason = message(error);
		}
	}
	return plan;
}

function contextPayload(source: LibraryV3Context): CreateContextItemRequest {
	return {
		kind: source.kind,
		name: source.name,
		description: source.description,
		...(source.kind === 'prompt'
			? { body: source.body }
			: source.kind === 'skill'
				? { files: source.files.map(({ path, content }) => ({ path, content })) }
				: { repo_url: source.repo_url, repo_branch: source.repo_branch, repo_dir: source.repo_dir })
	};
}

export async function applyLibraryV3Import(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	effects: DispatchEffects,
	request: ImportLibraryRequest
): Promise<ImportLibraryResponse> {
	const plan = await planLibraryV3Import(db, actor.userId, request);
	const report = () => {
		const entries = plan.steps.map((s) => s.entry);
		const counts = { create: 0, skip: 0, overwrite: 0, refuse: 0, error: 0 };
		for (const entry of entries) counts[entry.action]++;
		return { applied: !request.dry_run, entries, counts };
	};
	if (request.dry_run) return report();
	const entries = new Map(plan.steps.map((s) => [s.entry.local_id!, s.entry]));
	const attempt = async (entry: ImportPlanEntry, write: () => Promise<void>) => {
		if (!runnable(entry)) return;
		try {
			await write();
		} catch (error) {
			entry.action = 'error';
			entry.reason = message(error);
		}
	};
	// Drop planning placeholders: a failed create must never become a real scope/reference.
	for (const map of [plan.states, plan.projects, plan.labels])
		for (const [id, target] of map) if (target.startsWith('library-plan:')) map.delete(id);
	const written = new Map<string, WorkflowResponse>();
	for (const step of plan.workflows) {
		if (step.existing) {
			written.set(step.source.id, step.existing);
			continue;
		}
		await attempt(step.entry, async () => {
			const created = await createWorkflow(db, env, actor, step.definition);
			written.set(step.source.id, created);
			plan.workflowIds.set(step.source.id, created.id);
			step.entry.target_id = created.id;
			for (const state of step.source.states)
				plan.states.set(state.id, created.states.find((s) => s.name === state.name)!.id);
		});
	}
	const standard = (await loadWorkflows(db, actor.userId)).find(
		(w) => w.is_system && w.name === 'Standard'
	);
	const resolveState = (ref: NonNullable<LibraryV3Workflow['states'][number]['inherits_from']>) => {
		const id =
			ref.kind === 'bundled_state'
				? plan.states.get(ref.state_id)
				: standard?.states.find((s) => s.name === ref.state_name)?.id;
		if (!id) throw Error('Declared state dependency was not created or is no longer available');
		return id;
	};
	// Clear moving old edges first: otherwise a valid edge reversal can transiently form a cycle.
	for (const step of plan.workflows.filter((s) => s.existing && s.entry.action === 'overwrite'))
		await attempt(step.entry, async () => {
			const states = step.source.states.map((s) => {
				const old = step.existing!.states.find((state) => state.name === s.name)!;
				const target = s.inherits_from ? resolveState(s.inherits_from) : null;
				return {
					id: old.id,
					name: old.name,
					category: old.category,
					inherits_from: target === old.inherits_from ? target : null
				};
			});
			await updateWorkflow(db, env, actor, effects, step.existing!.id, { states });
		});
	// Every bundled state exists before pointers are applied, including interleaved workflow-level cycles.
	for (const step of plan.workflows)
		await attempt(step.entry, async () => {
			const workflow = written.get(step.source.id);
			if (!workflow) throw Error('Workflow was not created');
			await updateWorkflow(db, env, actor, effects, workflow.id, {
				states: step.source.states.map((s) => ({
					id: plan.states.get(s.id)!,
					name: s.name,
					category: s.category,
					inherits_from: s.inherits_from ? resolveState(s.inherits_from) : null
				}))
			});
		});
	for (const project of plan.document.projects)
		await attempt(entries.get(project.id)!, async () => {
			const ref = project.default_workflow;
			const defaultId =
				ref?.kind === 'bundled_workflow' ? plan.workflowIds.get(ref.workflow_id) : standard?.id;
			const created = await createProject(db, env, actor, {
				name: project.name,
				description: project.description,
				...(defaultId ? { default_workflow_id: defaultId } : {})
			});
			plan.projects.set(project.id, created.id);
			entries.get(project.id)!.target_id = created.id;
		});
	for (const label of plan.document.labels)
		await attempt(entries.get(label.id)!, async () => {
			const created = await createLabel(db, env, actor, { name: label.name, color: label.color });
			plan.labels.set(label.id, created.id);
			entries.get(label.id)!.target_id = created.id;
		});
	for (const source of plan.document.context)
		await attempt(entries.get(source.id)!, async () => {
			const payload = plan.context.get(source.id)!;
			const entry = entries.get(source.id)!;
			if (entry.action === 'overwrite') {
				await updateContextItem(db, env, actor, entry.target_id!, payload);
				return;
			}
			const project = source.scope.project_id ? plan.projects.get(source.scope.project_id) : null;
			const label = source.scope.label_id ? plan.labels.get(source.scope.label_id) : null;
			if (project === undefined || label === undefined)
				throw Error('Declared scope was not created');
			const created = await createContextItem(db, env, actor, {
				...payload,
				project_id: project,
				label_id: label,
				workflow_state_id: source.scope.state ? resolveState(source.scope.state) : null
			});
			entry.target_id = created.id;
		});
	return report();
}
