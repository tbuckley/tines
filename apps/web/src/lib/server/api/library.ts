import {
	LIBRARY_FORMAT,
	LIBRARY_MAX_ENTRIES,
	LIBRARY_VERSION,
	type ContextFile,
	type ContextKind,
	type CreateWorkflowRequest,
	type CreateContextItemRequest,
	type ImportAction,
	type ImportLibraryRequest,
	type ImportLibraryResponse,
	type ImportPlanEntry,
	type LibraryContextEntry,
	type LibraryDocument,
	type LibraryProject,
	type LibraryScopeRef,
	type WorkflowResponse,
	type WorkflowStateInput,
	type WorkflowTransitionInput
} from '@tines/shared';
import { applyLibraryV3Import, planLibraryV3Import } from './library-v3-import';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { ApiFail, requireString, type ActorContext } from './core';
import {
	contextItemQuery,
	createContextItem,
	isJournal,
	loadFiles,
	updateContextItem,
	validateContextCreateFields
} from './context';
import { createLabel, resolveLabelRef, normalizeLabelName } from './labels';
import { createProject, validateProjectFields } from './projects';
import type { DispatchEffects } from '$lib/server/dispatch-effects';
import { projectArchivedError } from './archive';
import {
	createWorkflow,
	loadWorkflows,
	workflowAsRequest,
	workflowFingerprint,
	validateWorkflowCreateFields
} from './workflows';

// ---------------------------------------------------------------------------
// The reusable library — non-system workflows plus every non-issue-scoped
// context item — in a form that moves between deployments. Everything is
// referenced by name, never by id, and the entries are shaped so that
// importing is a pass-through into the existing create paths rather than a
// second implementation of their validation.
//
// Explicitly not here: issues, comments, events, runs, schedules, artifacts,
// runner/supervisor config, and every credential.

/**
 * The system `Standard` workflow is seeded by migration `0002` with literal
 * ids that are identical on every instance, so exporting its definition would
 * only ever create a duplicate. Items scoped to its states export normally
 * and re-resolve by name.
 */
const isExportableWorkflow = (wf: { is_system: boolean }) => !wf.is_system;

// ---------------------------------------------------------------------------
// Export

export interface BuildLibraryOptions {
	/** Journals are this deployment's accumulated memory; opt out to omit them. */
	includeJournals?: boolean;
}

export async function buildLibraryDocument(
	db: Kysely<Database>,
	userId: string,
	{ includeJournals = true }: BuildLibraryOptions = {}
): Promise<LibraryDocument> {
	const [workflowRows, projectRows, contextRows] = await Promise.all([
		loadWorkflows(db, userId),
		db
			.selectFrom('project')
			.leftJoin('workflow', 'workflow.id', 'project.default_workflow_id')
			.select([
				'project.name as name',
				'project.description as description',
				'workflow.name as default_workflow'
			])
			.where('project.user_id', '=', userId)
			.orderBy('project.created_at asc')
			.execute(),
		contextItemQuery(db, userId)
			// Issue-scoped items are deployment-local (their issue does not
			// travel); artifacts are issue-scoped by construction, but the
			// kind is excluded on its own account too.
			.where('context_item.issue_id', 'is', null)
			.where('context_item.kind', 'not in', ['artifact', 'env'])
			.orderBy('context_item.position asc')
			.orderBy('context_item.created_at asc')
			.execute()
	]);

	const projects: LibraryProject[] = projectRows.map((p) => ({
		name: p.name,
		description: p.description,
		default_workflow: p.default_workflow ?? null
	}));

	const workflows: CreateWorkflowRequest[] = workflowRows.filter(isExportableWorkflow).map((wf) => {
		const stateName = new Map(wf.states.map((s) => [s.id, s.name]));
		const states: WorkflowStateInput[] = [...wf.states]
			.sort((a, b) => a.position - b.position)
			// State inheritance is historical inspection only; new exports are
			// pointer-free and never flatten the old edge.
			.map((s) => ({ name: s.name, category: s.category }));
		const transitions: WorkflowTransitionInput[] = wf.transitions.map((t) => ({
			name: t.name,
			from: stateName.get(t.from_state_id) ?? t.from_state_id,
			to: stateName.get(t.to_state_id) ?? t.to_state_id,
			...(t.requires && t.requires.length > 0 ? { requires: t.requires } : {})
		}));
		return {
			name: wf.name,
			description: wf.description,
			initial_state: stateName.get(wf.initial_state_id) ?? wf.initial_state_id,
			states,
			transitions
		};
	});

	const kept = contextRows.filter((row) => includeJournals || !isJournal(row));
	const files = await loadFiles(
		db,
		kept.filter((row) => row.kind === 'skill').map((row) => row.id)
	);

	const context: LibraryContextEntry[] = kept.map((row) => {
		const kind = row.kind as ContextKind;
		const entry: LibraryContextEntry = {
			kind,
			name: row.name,
			description: row.description,
			scope: {
				...(row.scope_project_name ? { project: row.scope_project_name } : {}),
				...(row.scope_state_name && row.scope_workflow_name
					? { state: { workflow: row.scope_workflow_name, name: row.scope_state_name } }
					: {}),
				...(row.scope_label_name ? { label: row.scope_label_name } : {})
			}
		};
		if (isJournal(row)) entry.journal = true;
		if (kind === 'prompt') entry.body = row.body ?? '';
		if (kind === 'skill') entry.files = files.get(row.id) ?? ([] as ContextFile[]);
		if (kind === 'repo') {
			entry.repo_url = row.repo_url ?? '';
			entry.repo_branch = row.repo_branch;
			entry.repo_dir = row.repo_dir;
		}
		return entry;
	});

	return {
		format: LIBRARY_FORMAT,
		version: LIBRARY_VERSION,
		exported_at: Date.now(),
		projects,
		workflows,
		context
	};
}

// ---------------------------------------------------------------------------
// Import: plan, then apply the same plan

/** Identity of a context entry in the report, e.g. `prompt "journal" (Tines / Research)`. */
function contextRef(entry: LibraryContextEntry): string {
	const scope = scopeRefLabel(entry.scope);
	return `${entry.kind} "${entry.name}" (${scope})`;
}

function scopeRefLabel(scope: LibraryScopeRef): string {
	const parts: string[] = [];
	if (scope.project) parts.push(`project ${scope.project}`);
	if (scope.state) parts.push(`state ${scope.state.workflow} / ${scope.state.name}`);
	if (scope.label) parts.push(`label ${scope.label}`);
	return parts.length === 0 ? 'global' : parts.join(' ∧ ');
}

/** Key delimiter: a NUL can never appear in a name, kind or id. */
const SEP = '\u0000';

/** Legacy documents remain readable, but non-null state pointers are not mutation input. */
function assertNoRemovedStateInheritance(workflows: unknown[]): void {
	for (const [wi, workflow] of workflows.entries()) {
		if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) continue;
		const states = (workflow as Record<string, unknown>).states;
		if (!Array.isArray(states)) continue;
		for (const [si, state] of states.entries()) {
			if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
			const raw = state as Record<string, unknown>;
			if (!Object.hasOwn(raw, 'inherits_from') || raw.inherits_from === null) continue;
			throw new ApiFail(
				422,
				'state_inheritance_removed',
				'State inheritance was removed; inspect or download this historical document, then provide a pointer-free document for mutation',
				{ field: `document.workflows[${wi}].states[${si}].inherits_from` }
			);
		}
	}
}

/** Structural key for collision detection: the `context_item_name_scope_uq` tuple. */
const contextKey = (
	kind: string,
	name: string,
	projectId: string | null,
	stateId: string | null,
	labelId: string | null
) => `${kind}${SEP}${name}${SEP}${projectId ?? ''}${SEP}${stateId ?? ''}${SEP}${labelId ?? ''}`;

/** The document gate: wrong file, future version, or too many entries. */
export function assertImportableDocument(doc: LibraryDocument | undefined | null): LibraryDocument {
	if (!doc || typeof doc !== 'object') {
		throw new ApiFail(422, 'invalid_field', '"document" must be an exported library document', {
			field: 'document'
		});
	}
	if (doc.format !== LIBRARY_FORMAT) {
		throw new ApiFail(
			422,
			'unsupported_format',
			`Not a Tines library export: expected "format": "${LIBRARY_FORMAT}", got ${JSON.stringify(doc.format ?? null)}`,
			{ field: 'document.format' }
		);
	}
	if (doc.version !== 1 && doc.version !== 2) {
		throw new ApiFail(
			422,
			'unsupported_format',
			`This export was written by a newer Tines (format version ${String(doc.version)}); this deployment reads version ${LIBRARY_VERSION}. Upgrade before importing.`,
			{ field: 'document.version', supported_version: LIBRARY_VERSION }
		);
	}
	const projects = doc.projects ?? [];
	const workflows = doc.workflows ?? [];
	const context = doc.context ?? [];
	for (const [name, entries] of [
		['projects', projects],
		['workflows', workflows],
		['context', context]
	] as const) {
		if (!Array.isArray(entries))
			throw new ApiFail(422, 'invalid_field', `document.${name} must be an array`);
	}
	assertNoRemovedStateInheritance(workflows);
	if (context.some((entry) => (entry?.kind as string) === 'env')) {
		throw new ApiFail(
			422,
			'invalid_field',
			'env items are deployment configuration and do not travel in library documents',
			{ field: 'document.context' }
		);
	}
	const total = projects.length + workflows.length + context.length;
	if (total > LIBRARY_MAX_ENTRIES) {
		throw new ApiFail(
			422,
			'document_too_large',
			`This document has ${total} entries; at most ${LIBRARY_MAX_ENTRIES} can be imported at once`,
			{ field: 'document', max_entries: LIBRARY_MAX_ENTRIES }
		);
	}
	return { ...doc, projects, workflows, context };
}

/** A planned step, carrying enough to execute it without re-deciding. */
interface PlannedStep {
	entry: ImportPlanEntry;
	project?: LibraryProject;
	workflow?: CreateWorkflowRequest;
	context?: LibraryContextEntry;
	/** The workflow this entry updates in place, for a pointer `overwrite`. */
	existing?: WorkflowResponse;
	/** Existing item id, for `overwrite`. */
	targetId?: string;
}

export interface ImportPlan {
	steps: PlannedStep[];
}

/**
 * Decide, without writing, what an import would do to this deployment.
 * Deliberately the same pass the apply runs, so a dry-run preview cannot
 * drift from what the confirm then does.
 */
export async function planImport(
	db: Kysely<Database>,
	userId: string,
	request: ImportLibraryRequest
): Promise<ImportPlan> {
	if (request.document?.version === 3) return planLibraryV3Import(db, userId, request);
	const doc = assertImportableDocument(request.document as LibraryDocument);
	const overwrite = request.on_collision === 'overwrite';
	const createProjects = request.create_projects !== false;
	const includeJournals = request.include_journals !== false;
	const rawWorkflows = doc.workflows;

	const invalidWorkflows: PlannedStep[] = [];
	const documentWorkflows: CreateWorkflowRequest[] = [];
	for (const raw of rawWorkflows) {
		try {
			const { name, description, def } = validateWorkflowCreateFields(raw);
			const names = new Map(def.states.map((state) => [state.id, state.name]));
			documentWorkflows.push({
				name,
				description,
				initial_state: names.get(def.initialStateId)!,
				states: def.states.map((state) => ({
					name: state.name,
					category: state.category,
					...(state.prompt === undefined ? {} : { prompt: state.prompt })
					// Pointer-free documents are the only mutation input after B.
				})),
				transitions: def.transitions.map((transition) => ({
					name: transition.name,
					from: names.get(transition.from_state_id)!,
					to: names.get(transition.to_state_id)!,
					...(transition.requires ? { requires: transition.requires } : {})
				}))
			});
		} catch (error) {
			invalidWorkflows.push({
				entry: {
					section: 'workflow',
					ref: `workflow "${raw?.name ?? '(invalid)'}"`,
					action: 'error',
					reason: errorMessage(error)
				}
			});
		}
	}

	const [projectRows, workflowRows, contextRows, labelRows] = await Promise.all([
		db
			.selectFrom('project')
			.select(['id', 'name', 'archived_at'])
			.where('user_id', '=', userId)
			.execute(),
		loadWorkflows(db, userId),
		contextItemQuery(db, userId).where('context_item.issue_id', 'is', null).execute(),
		db.selectFrom('label').select(['id', 'name']).where('user_id', '=', userId).execute()
	]);
	// Labels match by name, case-insensitively, as everywhere else.
	const labelIds = new Map(labelRows.map((l) => [l.name.toLowerCase(), l.id]));

	// Name → id for what exists now. Projects and workflows created earlier in
	// this same plan are recorded as `null`: known by name, id not yet known.
	const projectIds = new Map<string, string | null>(projectRows.map((p) => [p.name, p.id]));
	const sourceNames = new Map<string, number>();
	const destinationNames = new Map<string, WorkflowResponse[]>();
	for (const wf of rawWorkflows) {
		const name = typeof wf?.name === 'string' ? wf.name.trim() : null;
		if (name) sourceNames.set(name, (sourceNames.get(name) ?? 0) + 1);
	}
	for (const wf of workflowRows)
		destinationNames.set(wf.name, [...(destinationNames.get(wf.name) ?? []), wf]);
	const ambiguousNames = new Set([
		...[...sourceNames].filter(([, count]) => count > 1).map(([name]) => name),
		...[...destinationNames].filter(([, rows]) => rows.length > 1).map(([name]) => name)
	]);
	const ambiguityReason =
		'ambiguous workflow name in this legacy file or destination — use a v3 ID-addressed export or disambiguate the workflow names before importing';
	const stateIds = new Map<string, string | null>();
	for (const wf of workflowRows) {
		if (ambiguousNames.has(wf.name)) continue;
		for (const state of wf.states) stateIds.set(`${wf.name}${SEP}${state.name}`, state.id);
	}
	const workflowNames = new Map(
		workflowRows.filter((wf) => !ambiguousNames.has(wf.name)).map((wf) => [wf.name, wf])
	);
	// A project's default workflow resolves against what exists here plus what
	// this document brings; a name in `doc.workflows` ends up present either
	// way (created, or already here under that name).
	const availableWorkflows = new Set([
		...workflowNames.keys(),
		...documentWorkflows.filter((wf) => !ambiguousNames.has(wf.name)).map((wf) => wf.name)
	]);
	const existingContext = new Map(
		contextRows.map((row) => [
			contextKey(row.kind, row.name, row.project_id, row.workflow_state_id, row.label_id),
			row
		])
	);

	const steps: PlannedStep[] = [...invalidWorkflows];

	for (const rawProject of doc.projects) {
		let project = rawProject;
		const ref = `project "${project?.name ?? '(invalid)'}"`;
		try {
			project = { ...project, ...validateProjectFields(project) };
			if (project.default_workflow != null)
				project.default_workflow = requireString(project.default_workflow, 'default_workflow', {
					max: 200
				}).trim();
		} catch (error) {
			steps.push({
				entry: { section: 'project', ref, action: 'error', reason: errorMessage(error) }
			});
			continue;
		}
		if (project.default_workflow && ambiguousNames.has(project.default_workflow)) {
			steps.push({ entry: { section: 'project', ref, action: 'refuse', reason: ambiguityReason } });
			continue;
		}
		if (projectIds.has(project.name)) {
			steps.push({
				entry: {
					section: 'project',
					ref,
					action: 'skip',
					reason: 'a project with this name already exists'
				}
			});
			continue;
		}
		if (!createProjects) {
			steps.push({
				entry: {
					section: 'project',
					ref,
					action: 'skip',
					reason: 'creating missing projects is turned off'
				}
			});
			continue;
		}
		projectIds.set(project.name, null);
		const orphanDefault =
			project.default_workflow != null && !availableWorkflows.has(project.default_workflow);
		steps.push({
			entry: {
				section: 'project',
				ref,
				action: 'create',
				...(orphanDefault
					? {
							reason: `no workflow named "${project.default_workflow}" here or in this document, so the project keeps the system default`
						}
					: {})
			},
			project
		});
	}

	for (const workflow of documentWorkflows) {
		const ref = `workflow "${workflow.name}"`;
		if (ambiguousNames.has(workflow.name)) {
			steps.push({
				entry: {
					section: 'workflow',
					ref,
					action: 'refuse',
					reason: ambiguityReason
				}
			});
			continue;
		}
		const existing = workflowNames.get(workflow.name);
		if (existing) {
			const same =
				workflowFingerprint(workflowAsRequest(existing)) === workflowFingerprint(workflow);
			steps.push({
				entry: {
					section: 'workflow',
					ref,
					action: same ? 'skip' : 'refuse',
					reason: !same
						? 'a different workflow already has this name — rename or delete it first, then re-import. State-scoped context items below still land on the existing workflow.'
						: 'an identical workflow already exists'
				}
			});
			continue;
		}
		for (const s of workflow.states) stateIds.set(`${workflow.name}${SEP}${s.name}`, null);
		steps.push({ entry: { section: 'workflow', ref, action: 'create' }, workflow });
	}

	const workflowSteps = steps.filter((step) => step.workflow);

	for (const step of steps) {
		const project = step.project;
		if (!project?.default_workflow) continue;
		const name = project.default_workflow;
		if (
			!workflowNames.has(name) &&
			!workflowSteps.some((s) => s.workflow?.name === name && s.entry.action === 'create')
		) {
			step.entry.reason = `no workflow named "${name}" available after planning; the project keeps the system default`;
			project.default_workflow = null;
		}
	}

	const plannedContext = new Set<string>();
	for (const rawEntry of doc.context) {
		if (
			!rawEntry ||
			typeof rawEntry !== 'object' ||
			!rawEntry.scope ||
			typeof rawEntry.scope !== 'object' ||
			Array.isArray(rawEntry.scope)
		) {
			steps.push({
				entry: {
					section: 'context',
					ref: 'invalid context entry',
					action: 'error',
					reason: 'Context entry requires an object scope'
				}
			});
			continue;
		}
		let entry = rawEntry;
		const ref = contextRef(entry);
		if (entry.journal && !includeJournals) {
			steps.push({
				entry: {
					section: 'context',
					ref,
					action: 'skip',
					reason: 'journals are excluded from this import'
				}
			});
			continue;
		}
		if (entry.kind === 'artifact') {
			steps.push({
				entry: {
					section: 'context',
					ref,
					action: 'skip',
					reason: 'artifacts are issue data, not library content'
				}
			});
			continue;
		}

		try {
			if (Object.keys(entry.scope).some((key) => !['project', 'state', 'label'].includes(key)))
				throw new ApiFail(
					422,
					'invalid_scope',
					'Library context only supports project, state and label scope'
				);
			const fields = validateContextCreateFields({
				kind: entry.kind,
				name: entry.name,
				description: entry.description,
				...(entry.kind === 'prompt' || entry.body !== undefined ? { body: entry.body ?? '' } : {}),
				...(entry.files === undefined ? {} : { files: entry.files }),
				...(entry.repo_url === undefined ? {} : { repo_url: entry.repo_url }),
				...(entry.repo_branch === undefined ? {} : { repo_branch: entry.repo_branch }),
				...(entry.repo_dir === undefined ? {} : { repo_dir: entry.repo_dir })
			} as CreateContextItemRequest);
			entry = {
				...entry,
				name: fields.name,
				description: fields.description,
				...(fields.kind === 'prompt'
					? { body: fields.promptBody! }
					: fields.kind === 'skill'
						? { files: fields.files }
						: {
								repo_url: fields.repoUrl!,
								repo_branch: fields.repoBranch,
								repo_dir: fields.repoDir
							}),
				scope: { ...entry.scope }
			};
			if (entry.scope.project != null)
				entry.scope.project = requireString(entry.scope.project, 'scope.project', {
					max: 200
				}).trim();
			if (entry.scope.state != null)
				entry.scope.state = {
					workflow: requireString(entry.scope.state.workflow, 'scope.state.workflow', {
						max: 200
					}).trim(),
					name: requireString(entry.scope.state.name, 'scope.state.name', { max: 100 }).trim()
				};
			if (entry.scope.label != null) entry.scope.label = normalizeLabelName(entry.scope.label);
		} catch (error) {
			steps.push({
				entry: { section: 'context', ref, action: 'error', reason: errorMessage(error) }
			});
			continue;
		}
		if (entry.scope.state && ambiguousNames.has(entry.scope.state.workflow)) {
			steps.push({ entry: { section: 'context', ref, action: 'refuse', reason: ambiguityReason } });
			continue;
		}
		const stateKey = entry.scope.state
			? `${entry.scope.state.workflow}${SEP}${entry.scope.state.name}`
			: null;
		if (entry.scope.project && !projectIds.has(entry.scope.project)) {
			steps.push({
				entry: {
					section: 'context',
					ref,
					action: 'skip',
					reason: `no project named "${entry.scope.project}" here, and none is being created`
				}
			});
			continue;
		}
		if (stateKey && !stateIds.has(stateKey)) {
			steps.push({
				entry: {
					section: 'context',
					ref,
					action: 'skip',
					reason: `no state "${entry.scope.state?.name}" in workflow "${entry.scope.state?.workflow}" here`
				}
			});
			continue;
		}

		const contextIdentity = JSON.stringify([
			entry.kind,
			entry.name,
			entry.scope.project ?? null,
			entry.scope.state?.workflow ?? null,
			entry.scope.state?.name ?? null,
			entry.scope.label?.toLowerCase() ?? null
		]);
		if (plannedContext.has(contextIdentity)) {
			steps.push({
				entry: {
					section: 'context',
					ref,
					action: 'error',
					reason: 'Duplicate context kind/name at the same scope in this document'
				}
			});
			continue;
		}
		plannedContext.add(contextIdentity);
		const projectId = entry.scope.project ? (projectIds.get(entry.scope.project) ?? null) : null;
		const stateId = stateKey ? (stateIds.get(stateKey) ?? null) : null;
		// A label the deployment lacks is created by the import (labels are
		// flat and cheap, unlike a project or a workflow, which must already
		// exist to be scoped to) — so a missing one is pending, not a skip.
		const labelId = entry.scope.label
			? (labelIds.get(entry.scope.label.toLowerCase()) ?? null)
			: null;
		// A scope whose carrier is only being created in this same import
		// cannot collide with anything that already exists.
		const pending =
			(entry.scope.project && projectId === null) ||
			(stateKey !== null && stateId === null) ||
			(!!entry.scope.label && labelId === null);
		const existing = pending
			? undefined
			: existingContext.get(contextKey(entry.kind, entry.name, projectId, stateId, labelId));

		const project = projectRows.find((project) => project.id === projectId);
		if ((!existing || overwrite) && project?.archived_at != null) {
			steps.push({
				entry: {
					section: 'context',
					ref,
					action: 'error',
					reason: projectArchivedError(project).message
				}
			});
			continue;
		}
		if (existing) {
			steps.push(
				overwrite
					? {
							entry: {
								section: 'context',
								ref,
								action: 'overwrite',
								reason: 'replacing the existing item'
							},
							context: entry,
							targetId: existing.id
						}
					: {
							entry: {
								section: 'context',
								ref,
								action: 'skip',
								reason: 'an item with this name and scope already exists'
							}
						}
			);
			continue;
		}
		steps.push({ entry: { section: 'context', ref, action: 'create' }, context: entry });
	}

	return { steps };
}

function tally(entries: ImportPlanEntry[]): Record<ImportAction, number> {
	const counts: Record<ImportAction, number> = {
		create: 0,
		skip: 0,
		overwrite: 0,
		refuse: 0,
		error: 0
	};
	for (const e of entries) counts[e.action] += 1;
	return counts;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Execute a plan: projects, then workflows, then context (so scope carriers
 * exist before the items that point at them). Each create is already one
 * atomic batch of its own; a failure marks that entry and the rest proceeds,
 * which — with skip-on-collision — makes re-running a partial import converge
 * rather than compounding.
 */
export async function applyImport(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	effects: DispatchEffects,
	request: ImportLibraryRequest
): Promise<ImportLibraryResponse> {
	if (request.document?.version === 3)
		return applyLibraryV3Import(db, env, actor, effects, request);
	const plan = await planImport(db, actor.userId, request);
	if (request.dry_run) {
		const entries = plan.steps.map((s) => s.entry);
		return { applied: false, entries, counts: tally(entries) };
	}

	// Names resolved as we go: a project created in this pass is what the
	// context entries scoped to it must resolve against.
	const projectIds = new Map<string, string>();
	const stateIds = new Map<string, string>();
	const workflowIds = new Map<string, string>();
	// Labels created by this import, keyed lower-case; also memoises lookups.
	const labelIds = new Map<string, string>();

	// Workflows before projects (a project's default workflow must exist to be
	// pointed at), context last (every scope carrier is in place by then). The
	// report keeps the plan's own order.
	const runnable = plan.steps.filter(
		(s) => s.entry.action === 'create' || s.entry.action === 'overwrite'
	);
	const ordered = [
		...runnable.filter((s) => s.workflow),
		...runnable.filter((s) => s.project),
		...runnable.filter((s) => s.context)
	];

	for (const step of ordered) {
		try {
			if (step.workflow) {
				const written = await createWorkflow(db, env, actor, step.workflow);
				workflowIds.set(written.name, written.id);
				for (const s of written.states) stateIds.set(`${written.name}${SEP}${s.name}`, s.id);
			} else if (step.project) {
				// Unresolvable defaults are planned with a reason and land as a
				// project on the system default rather than failing the entry.
				const defaultWorkflowId = step.project.default_workflow
					? (workflowIds.get(step.project.default_workflow) ??
						(await lookupWorkflowId(db, actor.userId, step.project.default_workflow)))
					: undefined;
				const created = await createProject(db, env, actor, {
					name: step.project.name,
					description: step.project.description ?? '',
					...(defaultWorkflowId ? { default_workflow_id: defaultWorkflowId } : {})
				});
				projectIds.set(created.name, created.id);
			} else if (step.context) {
				await writeContextEntry(db, env, actor, step, projectIds, stateIds, labelIds);
			}
		} catch (e) {
			step.entry.action = 'error';
			step.entry.reason = errorMessage(e);
		}
	}

	const entries = plan.steps.map((s) => s.entry);
	return { applied: true, entries, counts: tally(entries) };
}

/** Resolve an entry's scope to ids and hand its payload to the normal create/update path. */
async function writeContextEntry(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	step: PlannedStep,
	createdProjects: Map<string, string>,
	createdStates: Map<string, string>,
	labelIds: Map<string, string>
): Promise<void> {
	const entry = step.context!;
	const payload = {
		description: entry.description ?? '',
		...(entry.kind === 'prompt' ? { body: entry.body ?? '' } : {}),
		...(entry.kind === 'skill' ? { files: entry.files ?? [] } : {}),
		...(entry.kind === 'repo'
			? {
					repo_url: entry.repo_url ?? '',
					repo_branch: entry.repo_branch ?? null,
					repo_dir: entry.repo_dir ?? null
				}
			: {})
	};

	if (step.entry.action === 'overwrite') {
		await updateContextItem(db, env, actor, step.targetId!, payload);
		return;
	}

	let projectId: string | null = null;
	if (entry.scope.project) {
		projectId =
			createdProjects.get(entry.scope.project) ??
			(
				await db
					.selectFrom('project')
					.select('id')
					.where('user_id', '=', actor.userId)
					.where('name', '=', entry.scope.project)
					.executeTakeFirst()
			)?.id ??
			null;
		if (!projectId) throw new Error(`project "${entry.scope.project}" could not be resolved`);
	}

	let stateId: string | null = null;
	if (entry.scope.state) {
		const key = `${entry.scope.state.workflow}${SEP}${entry.scope.state.name}`;
		stateId =
			createdStates.get(key) ?? (await lookupStateId(db, actor.userId, entry.scope.state)) ?? null;
		if (!stateId) {
			throw new Error(
				`state "${entry.scope.state.name}" in workflow "${entry.scope.state.workflow}" could not be resolved`
			);
		}
	}

	let labelId: string | null = null;
	if (entry.scope.label) {
		const key = entry.scope.label.toLowerCase();
		labelId =
			labelIds.get(key) ??
			(await resolveLabelRef(db, actor.userId, entry.scope.label))?.id ??
			// Unlike a project or a workflow, a label carries nothing but its
			// name — creating the missing one is cheaper and less surprising
			// than dropping the item's scope or skipping it.
			(await createLabel(db, env, actor, { name: entry.scope.label })).id;
		labelIds.set(key, labelId);
	}

	await createContextItem(db, env, actor, {
		kind: entry.kind,
		name: entry.name,
		project_id: projectId,
		workflow_state_id: stateId,
		label_id: labelId,
		...payload
	});
}

async function lookupWorkflowId(
	db: Kysely<Database>,
	userId: string,
	name: string
): Promise<string | undefined> {
	const rows = await db
		.selectFrom('workflow')
		.select('id')
		// The system workflow is owned by no user but visible to everyone.
		.where((eb) => eb.or([eb('user_id', '=', userId), eb('user_id', 'is', null)]))
		.where('name', '=', name)
		.execute();
	if (rows.length > 1) throw new Error('Ambiguous legacy workflow or state name; use a v3 export');
	return rows[0]?.id;
}

async function lookupStateId(
	db: Kysely<Database>,
	userId: string,
	ref: { workflow: string; name: string }
): Promise<string | undefined> {
	await lookupWorkflowId(db, userId, ref.workflow);
	const rows = await db
		.selectFrom('workflow_state')
		.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
		// The system workflow is owned by no user but visible to everyone.
		.where((eb) => eb.or([eb('workflow.user_id', '=', userId), eb('workflow.user_id', 'is', null)]))
		.where('workflow.name', '=', ref.workflow)
		.where('workflow_state.name', '=', ref.name)
		.select('workflow_state.id as id')
		.execute();
	if (rows.length > 1) throw new Error('Ambiguous legacy workflow or state name; use a v3 export');
	return rows[0]?.id;
}
