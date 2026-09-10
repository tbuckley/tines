import {
	LIBRARY_FORMAT,
	LIBRARY_MAX_ENTRIES,
	LIBRARY_VERSION,
	type ContextFile,
	type ContextKind,
	type CreateWorkflowRequest,
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
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { ApiFail, type ActorContext } from './core';
import {
	contextItemQuery,
	createContextItem,
	isJournal,
	loadFiles,
	updateContextItem
} from './context';
import { createLabel, resolveLabelRef } from './labels';
import { createProject } from './projects';
import {
	createWorkflow,
	loadWorkflows,
	updateWorkflow,
	workflowAsRequest,
	workflowFingerprint
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
			.where('context_item.kind', '!=', 'artifact')
			.orderBy('context_item.position asc')
			.orderBy('context_item.created_at asc')
			.execute()
	]);

	const projects: LibraryProject[] = projectRows.map((p) => ({
		name: p.name,
		description: p.description,
		default_workflow: p.default_workflow ?? null
	}));

	// Every state this deployment can see, by id — including the standard
	// workflow's, which is never exported but can be a base.
	const baseRef = new Map<string, string>();
	for (const wf of workflowRows) {
		for (const s of wf.states) baseRef.set(s.id, stateRefName(wf.name, s.name));
	}

	const workflows: CreateWorkflowRequest[] = workflowRows.filter(isExportableWorkflow).map((wf) => {
		const stateName = new Map(wf.states.map((s) => [s.id, s.name]));
		const states: WorkflowStateInput[] = [...wf.states]
			.sort((a, b) => a.position - b.position)
			// Array order carries position; `prompt` is not used — stage
			// instructions travel as ordinary state-scoped context items.
			// An inheritance pointer travels by name on both sides, so it can
			// be re-resolved on a deployment that shares none of these ids; a
			// state with no base carries no key at all, which is what keeps a
			// pointer-free deployment exporting the version 1 document.
			.map((s) => {
				const base = s.inherits_from ? baseRef.get(s.inherits_from) : undefined;
				return { name: s.name, category: s.category, ...(base ? { inherits_from: base } : {}) };
			});
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

/**
 * A state's portable identity in a library document — how an inheritance
 * pointer names its base, since ids are not shared between deployments.
 */
const stateRefName = (workflow: string, state: string) => `${workflow}/${state}`;

/**
 * Every way a `<workflow>/<state>` ref could split. Both halves are free-form
 * names that may themselves contain a slash, so the ref is ambiguous on its
 * own and the caller resolves each candidate until one names something real.
 */
function splitCandidates(ref: string): [string, string][] {
	const out: [string, string][] = [];
	for (let i = ref.indexOf('/'); i !== -1; i = ref.indexOf('/', i + 1)) {
		out.push([ref.slice(0, i), ref.slice(i + 1)]);
	}
	return out;
}

/** First candidate that resolves, or undefined. */
function resolveStateRef<T>(
	ref: string,
	resolve: (workflow: string, state: string) => T | undefined
): T | undefined {
	for (const [workflow, state] of splitCandidates(ref)) {
		const found = resolve(workflow, state);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** The ref as a message names it, matching the inheritance 422s: `<workflow> / <state>`. */
function stateRefLabel(ref: string): string {
	const i = ref.indexOf('/');
	return i === -1 ? ref : `${ref.slice(0, i)} / ${ref.slice(i + 1)}`;
}

/** The pointer a state carries in a document, or null (a bare `null` clears nothing here). */
const baseRefOf = (state: WorkflowStateInput): string | null =>
	typeof state.inherits_from === 'string' && state.inherits_from ? state.inherits_from : null;

/** Every state this deployment can see, by id, as the ref a document names it by. */
function baseRefIndex(workflows: WorkflowResponse[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const wf of workflows) {
		for (const s of wf.states) out.set(s.id, stateRefName(wf.name, s.name));
	}
	return out;
}

/** A stored workflow's pointers as portable refs, by state name. */
function storedPointers(wf: WorkflowResponse, baseRef: Map<string, string>): Map<string, string> {
	const out = new Map<string, string>();
	for (const s of wf.states) {
		const ref = s.inherits_from ? baseRef.get(s.inherits_from) : undefined;
		if (ref) out.set(s.name, ref);
	}
	return out;
}

/**
 * A document workflow's pointers as the same portable refs, by state name —
 * the create path's bare in-workflow name qualified, so the two sides of a
 * comparison speak one form.
 */
function documentPointers(workflow: CreateWorkflowRequest): Map<string, string> {
	const out = new Map<string, string>();
	for (const state of workflow.states) {
		const ref = baseRefOf(state);
		if (ref === null) continue;
		out.set(
			state.name,
			workflow.states.some((s) => s.name === ref) ? stateRefName(workflow.name, ref) : ref
		);
	}
	return out;
}

/** The states whose pointer a document and a stored workflow disagree on, named. */
function pointerDifference(want: Map<string, string>, have: Map<string, string>): string[] {
	const names = new Set([...want.keys(), ...have.keys()]);
	return [...names].filter((n) => (want.get(n) ?? null) !== (have.get(n) ?? null)).sort();
}

/**
 * The first pointer in `workflow` that names neither one of the workflow's own
 * states nor a state in `known` (this deployment plus what this document
 * brings), or null when every pointer resolves.
 */
function unresolvableBase(
	workflow: CreateWorkflowRequest,
	known: Map<string, string | null>
): { state: string; ref: string } | null {
	for (const state of workflow.states) {
		const ref = baseRefOf(state);
		if (ref === null) continue;
		// A bare state name is the create path's own in-request form; keep
		// accepting it so a hand-written document is not refused for using it.
		if (workflow.states.some((s) => s.name === ref)) continue;
		const found = resolveStateRef(ref, (w, n) => (known.has(`${w}${SEP}${n}`) ? true : undefined));
		if (!found) return { state: state.name, ref };
	}
	return null;
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
	if (typeof doc.version !== 'number' || doc.version > LIBRARY_VERSION) {
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
	const doc = assertImportableDocument(request.document);
	const overwrite = request.on_collision === 'overwrite';
	const createProjects = request.create_projects !== false;
	const includeJournals = request.include_journals !== false;
	// Version 1 had no inheritance semantics. Some hand-authored v1 files did
	// nevertheless contain the later field; accepting those bytes must not let
	// them compare, clear, or set a destination pointer.
	const documentWorkflows =
		doc.version >= 2
			? doc.workflows
			: doc.workflows.map((workflow) => ({
					...workflow,
					states: workflow.states.map(({ inherits_from: _ignored, ...state }) => state)
				}));

	const [projectRows, workflowRows, contextRows, labelRows] = await Promise.all([
		db.selectFrom('project').select(['id', 'name']).where('user_id', '=', userId).execute(),
		loadWorkflows(db, userId),
		contextItemQuery(db, userId).where('context_item.issue_id', 'is', null).execute(),
		db.selectFrom('label').select(['id', 'name']).where('user_id', '=', userId).execute()
	]);
	// Labels match by name, case-insensitively, as everywhere else.
	const labelIds = new Map(labelRows.map((l) => [l.name.toLowerCase(), l.id]));

	// Name → id for what exists now. Projects and workflows created earlier in
	// this same plan are recorded as `null`: known by name, id not yet known.
	const projectIds = new Map<string, string | null>(projectRows.map((p) => [p.name, p.id]));
	const stateIds = new Map<string, string | null>();
	for (const wf of workflowRows) {
		for (const s of wf.states) stateIds.set(`${wf.name}${SEP}${s.name}`, s.id);
	}
	const workflowNames = new Map(workflowRows.map((wf) => [wf.name, wf]));
	const baseRef = baseRefIndex(workflowRows);
	// A project's default workflow resolves against what exists here plus what
	// this document brings; a name in `doc.workflows` ends up present either
	// way (created, or already here under that name).
	const availableWorkflows = new Set([
		...workflowNames.keys(),
		...documentWorkflows.map((wf) => wf.name)
	]);
	const existingContext = new Map(
		contextRows.map((row) => [
			contextKey(row.kind, row.name, row.project_id, row.workflow_state_id, row.label_id),
			row
		])
	);

	const steps: PlannedStep[] = [];

	for (const project of doc.projects) {
		const ref = `project "${project.name}"`;
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
		const existing = workflowNames.get(workflow.name);
		if (existing) {
			const same =
				workflowFingerprint(workflowAsRequest(existing)) === workflowFingerprint(workflow);
			// The fingerprint is structure only — deliberately, since stage
			// instructions and inheritance are edited independently of the
			// shape. So two workflows that agree on it can still disagree on
			// their pointers, which is what a deployment that took an earlier
			// version 1 export of this same library looks like. Calling that
			// "identical" would drop every pointer in silence, so the
			// difference is either applied (on request) or named and refused.
			const differing =
				doc.version >= 2 && same
					? pointerDifference(documentPointers(workflow), storedPointers(existing, baseRef))
					: [];
			const states = differing.map((n) => `"${n}"`).join(', ');
			if (same && differing.length > 0 && overwrite && !existing.is_system) {
				steps.push({
					entry: {
						section: 'workflow',
						ref,
						action: 'overwrite',
						reason: `the same workflow is here already; updating the inheritance pointers on ${states}`
					},
					workflow,
					existing
				});
				continue;
			}
			steps.push({
				entry: {
					section: 'workflow',
					ref,
					action: same && differing.length === 0 ? 'skip' : 'refuse',
					reason: !same
						? 'a different workflow already has this name — rename or delete it first, then re-import. State-scoped context items below still land on the existing workflow.'
						: differing.length === 0
							? 'an identical workflow already exists'
							: existing.is_system
								? `the same workflow is here already but its inheritance pointers differ on ${states}, and the standard workflow is read-only`
								: `the same workflow is here already but its inheritance pointers differ on ${states} — import again with on_collision=overwrite to update them. State-scoped context items below still land on the existing workflow.`
				}
			});
			continue;
		}
		for (const s of workflow.states) stateIds.set(`${workflow.name}${SEP}${s.name}`, null);
		steps.push({ entry: { section: 'workflow', ref, action: 'create' }, workflow });
	}

	// Inheritance pointers (format version 2 and up). A base must be a state
	// this deployment already has or one a workflow in this document brings —
	// in either order, since every workflow's states are known by name before
	// this runs. A workflow whose base is missing is refused whole: creating
	// it with the pointer silently dropped would import stages that look right
	// and inherit nothing. Refusing one can strand its own children, so the
	// sweep repeats until no more entries move.
	const workflowSteps = steps.filter((step) => step.workflow);
	for (let moved = true; moved;) {
		moved = false;
		for (const step of workflowSteps) {
			if (step.entry.action !== 'create' && step.entry.action !== 'overwrite') continue;
			const missing = unresolvableBase(step.workflow!, stateIds);
			if (!missing) continue;
			step.entry.action = 'refuse';
			step.entry.reason = `state "${missing.state}" inherits from ${stateRefLabel(missing.ref)}, which is neither in this document nor on this deployment — import that workflow first, or clear the pointer`;
			// A workflow this import would have created takes its states back
			// out of the index; one that is only being updated keeps them,
			// since they exist here whatever happens to its pointers.
			if (!step.existing)
				for (const s of step.workflow!.states)
					stateIds.delete(`${step.workflow!.name}${SEP}${s.name}`);
			moved = true;
		}
	}

	for (const entry of doc.context) {
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
	request: ImportLibraryRequest
): Promise<ImportLibraryResponse> {
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

	// Pointers whose base a workflow later in this document brings: they cannot
	// be part of the create, so they are patched on once every workflow exists.
	const deferred: DeferredPointer[] = [];
	const createdWorkflows = new Map<string, WorkflowResponse>();

	for (const step of ordered) {
		try {
			if (step.workflow) {
				// An `overwrite` here is a workflow the target already has,
				// structurally identical, whose pointers this document moves;
				// everything else is a create.
				const written = step.existing
					? await overwritePointers(
							db,
							env,
							actor,
							step.existing,
							step.workflow,
							stateIds,
							deferred
						)
					: await createWorkflow(
							db,
							env,
							actor,
							await resolveWorkflowPointers(db, actor.userId, step.workflow, stateIds, deferred)
						);
				workflowIds.set(written.name, written.id);
				createdWorkflows.set(written.name, written);
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

	await applyDeferredPointers(db, env, actor, ordered, createdWorkflows, stateIds, deferred);

	const entries = plan.steps.map((s) => s.entry);
	return { applied: true, entries, counts: tally(entries) };
}

/** A pointer this import must patch on after every workflow in it exists. */
interface DeferredPointer {
	/** The child state's workflow, by name — it is being created in this pass. */
	workflow: string;
	/** The child state, by name. */
	state: string;
	/** The `<workflow>/<state>` ref, still unresolved. */
	ref: string;
}

/**
 * The document's `<workflow>/<state>` pointers as the create path wants them:
 * a name for a base in the same workflow (which `resolveDef` resolves against
 * the request's own states) and a state id for one anywhere else. A base a
 * later workflow in this same document brings has no id yet, so it is dropped
 * from the create and recorded in `deferred`.
 */
async function resolveWorkflowPointers(
	db: Kysely<Database>,
	userId: string,
	workflow: CreateWorkflowRequest,
	stateIds: Map<string, string>,
	deferred: DeferredPointer[]
): Promise<CreateWorkflowRequest> {
	const states: WorkflowStateInput[] = [];
	for (const state of workflow.states) {
		const ref = baseRefOf(state);
		if (ref === null) {
			states.push(state);
			continue;
		}
		const own = workflow.states.some((s) => s.name === ref)
			? ref
			: resolveStateRef(ref, (w, n) =>
					w === workflow.name && workflow.states.some((s) => s.name === n) ? n : undefined
				);
		const resolved = own ?? (await lookupBaseId(db, userId, ref, stateIds));
		if (resolved === undefined) {
			deferred.push({ workflow: workflow.name, state: state.name, ref });
			const { inherits_from: _dropped, ...rest } = state;
			states.push(rest);
			continue;
		}
		states.push({ ...state, inherits_from: resolved });
	}
	return { ...workflow, states };
}

/**
 * The `overwrite` counterpart of `resolveWorkflowPointers`: the document's
 * pointers, patched onto a workflow that already exists here through the same
 * update path the editor uses. States are re-sent by id and every pointer is
 * stated explicitly — a state the document gives no base gets `null`, since
 * an absent `inherits_from` means "unchanged" — so nothing but the pointers
 * moves. A base a later workflow in this document brings is deferred exactly
 * as it is on the create path.
 */
async function overwritePointers(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	existing: WorkflowResponse,
	workflow: CreateWorkflowRequest,
	stateIds: Map<string, string>,
	deferred: DeferredPointer[]
): Promise<WorkflowResponse> {
	const want = documentPointers(workflow);
	const idByName = new Map(existing.states.map((s) => [s.name, s.id]));
	const states: WorkflowStateInput[] = [];
	for (const state of [...existing.states].sort((a, b) => a.position - b.position)) {
		const base = { id: state.id, name: state.name, category: state.category };
		const ref = want.get(state.name);
		if (ref === undefined) {
			states.push({ ...base, inherits_from: null });
			continue;
		}
		const own = resolveStateRef(ref, (w, n) => (w === existing.name ? idByName.get(n) : undefined));
		const resolved = own ?? (await lookupBaseId(db, actor.userId, ref, stateIds));
		if (resolved === undefined) {
			deferred.push({ workflow: existing.name, state: state.name, ref });
			// Left as it stands until the second pass sets it.
			states.push(base);
			continue;
		}
		states.push({ ...base, inherits_from: resolved });
	}
	return updateWorkflow(db, env, actor, existing.id, { states });
}

/** A `<workflow>/<state>` ref as a state id: created in this pass, else stored here. */
async function lookupBaseId(
	db: Kysely<Database>,
	userId: string,
	ref: string,
	stateIds: Map<string, string>
): Promise<string | undefined> {
	const created = resolveStateRef(ref, (w, n) => stateIds.get(`${w}${SEP}${n}`));
	if (created !== undefined) return created;
	for (const [workflow, name] of splitCandidates(ref)) {
		const id = await lookupStateId(db, userId, { workflow, name });
		if (id !== undefined) return id;
	}
	return undefined;
}

/**
 * The second pass: every deferred pointer, patched on through the same update
 * path the workflow editor uses. States are re-sent by id, so nothing but the
 * pointers moves; a workflow whose create failed has none to patch.
 */
async function applyDeferredPointers(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	steps: PlannedStep[],
	createdWorkflows: Map<string, WorkflowResponse>,
	stateIds: Map<string, string>,
	deferred: DeferredPointer[]
): Promise<void> {
	if (deferred.length === 0) return;
	for (const [workflowName, pointers] of groupByWorkflow(deferred)) {
		const created = createdWorkflows.get(workflowName);
		if (!created) continue;
		const step = steps.find((s) => s.workflow?.name === workflowName);
		try {
			const bases = new Map<string, string>();
			for (const pointer of pointers) {
				const id = await lookupBaseId(db, actor.userId, pointer.ref, stateIds);
				if (id === undefined) {
					throw new Error(
						`state "${pointer.state}" inherits from ${stateRefLabel(pointer.ref)}, which this import did not create`
					);
				}
				bases.set(pointer.state, id);
			}
			const states: WorkflowStateInput[] = [...created.states]
				.sort((a, b) => a.position - b.position)
				.map((s) => ({
					id: s.id,
					name: s.name,
					category: s.category,
					...(bases.has(s.name) ? { inherits_from: bases.get(s.name)! } : {})
				}));
			await updateWorkflow(db, env, actor, created.id, { states });
		} catch (e) {
			if (step) {
				step.entry.action = 'error';
				step.entry.reason = errorMessage(e);
			}
		}
	}
}

function groupByWorkflow(deferred: DeferredPointer[]): Map<string, DeferredPointer[]> {
	const out = new Map<string, DeferredPointer[]>();
	for (const pointer of deferred) {
		const list = out.get(pointer.workflow);
		if (list) list.push(pointer);
		else out.set(pointer.workflow, [pointer]);
	}
	return out;
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
	const row = await db
		.selectFrom('workflow')
		.select('id')
		// The system workflow is owned by no user but visible to everyone.
		.where((eb) => eb.or([eb('user_id', '=', userId), eb('user_id', 'is', null)]))
		.where('name', '=', name)
		.executeTakeFirst();
	return row?.id;
}

async function lookupStateId(
	db: Kysely<Database>,
	userId: string,
	ref: { workflow: string; name: string }
): Promise<string | undefined> {
	const row = await db
		.selectFrom('workflow_state')
		.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
		// The system workflow is owned by no user but visible to everyone.
		.where((eb) => eb.or([eb('workflow.user_id', '=', userId), eb('workflow.user_id', 'is', null)]))
		.where('workflow.name', '=', ref.workflow)
		.where('workflow_state.name', '=', ref.name)
		.select('workflow_state.id as id')
		.executeTakeFirst();
	return row?.id;
}
