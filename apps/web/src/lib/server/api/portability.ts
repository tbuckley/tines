/**
 * Configuration export / import.
 *
 * The document carries an account's *configuration* — user workflows and the
 * shared context items that surround them — as a name-keyed, id-free JSON
 * graph, so it round-trips between accounts and instances. It is deliberately
 * not a backup: issues, comments, events, runs, runners, routing rules,
 * schedules, API keys and supervisor settings are all out.
 *
 * Two boundaries are load-bearing:
 *
 * - **Issue-scoped items are excluded**, and artifacts are always issue-scoped,
 *   so the document never references R2 — it is pure D1 text.
 * - **Serialization is an allowlist** of explicit fields, never a row spread,
 *   so a future column (or the secret-bearing tables one join away) cannot
 *   leak into a file users hand around.
 */
import type {
	ConfigExport,
	ContextFile,
	ExportedContextItem,
	ExportedProject,
	ExportedScope,
	ExportedWorkflow,
	ImportApplyResult,
	ImportMode,
	ImportPlan,
	ImportPlanEntry,
	UpdateContextItemRequest
} from '@tines/shared';
import { TINES_EXPORT_VERSION } from '@tines/shared';
import type { CompiledQuery, Kysely } from 'kysely';
import { idChunks, newId, type Database } from '$lib/server/db';
import {
	isJournal,
	updateContextItem,
	validateFiles,
	validateName,
	validatePromptBody,
	validateWorkspacePath
} from './context';
import {
	ApiFail,
	optionalString,
	requireString,
	runAtomic,
	type ActorContext
} from './core';
import { eventInsert } from './events';
import { scopeLabel } from './scope';
import { createWorkflowQueries, loadWorkflows } from './workflows';

/** Kinds that can appear in an export (artifacts are issue-scoped, always). */
const EXPORTABLE_KINDS = new Set(['prompt', 'skill', 'repo']);

/**
 * Serializes the account's configuration. Ordering is by name throughout —
 * never by id or timestamp — so two isomorphic accounts produce byte-comparable
 * documents and one instance's export can be diffed against another's.
 */
export async function buildExport(db: Kysely<Database>, userId: string): Promise<ConfigExport> {
	const workflows = await loadWorkflows(db, userId);
	const userWorkflows = workflows.filter((w) => !w.is_system);
	const systemWorkflow = workflows.find((w) => w.is_system);

	// State id → the name-based ref used in scopes, for every workflow the
	// account can see (its own, plus the shared system workflow).
	const stateRefById = new Map<string, { workflow: string; state: string; system: boolean }>();
	for (const wf of workflows) {
		for (const s of wf.states) {
			stateRefById.set(s.id, { workflow: wf.name, state: s.name, system: wf.is_system });
		}
	}

	const exportedWorkflows: ExportedWorkflow[] = userWorkflows
		.map((wf) => {
			const nameById = new Map(wf.states.map((s) => [s.id, s.name]));
			return {
				name: wf.name,
				description: wf.description,
				initial_state: nameById.get(wf.initial_state_id) ?? wf.states[0]?.name ?? '',
				states: [...wf.states]
					.sort((a, b) => a.position - b.position)
					.map((s) => ({ name: s.name, category: s.category, position: s.position })),
				transitions: wf.transitions
					.map((t) => ({
						name: t.name,
						from: nameById.get(t.from_state_id) ?? '',
						to: nameById.get(t.to_state_id) ?? '',
						...(t.requires && t.requires.length > 0 ? { requires: t.requires } : {})
					}))
					.filter((t) => t.from !== '' && t.to !== '')
					.sort((a, b) => a.from.localeCompare(b.from) || a.name.localeCompare(b.name))
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));

	// Context items: everything the user owns that is not issue-scoped. Read in
	// (scope, position) order so the importer can append in export order and
	// reproduce prompt-stitching order without copying absolute positions.
	const rows = await db
		.selectFrom('context_item')
		.select([
			'id',
			'kind',
			'name',
			'description',
			'project_id',
			'workflow_state_id',
			'body',
			'repo_url',
			'repo_branch',
			'repo_dir',
			'position'
		])
		.where('user_id', '=', userId)
		.where('issue_id', 'is', null)
		.orderBy('project_id asc')
		.orderBy('workflow_state_id asc')
		.orderBy('position asc')
		.orderBy('id asc')
		.execute();

	const skippedIssueScoped = await db
		.selectFrom('context_item')
		.select((eb) => eb.fn.countAll<number>().as('n'))
		.where('user_id', '=', userId)
		.where('issue_id', 'is not', null)
		.executeTakeFirst();

	const exportable = rows.filter((r) => EXPORTABLE_KINDS.has(r.kind));

	// Skill file bodies, chunked against D1's 100-parameter statement cap.
	const skillIds = exportable.filter((r) => r.kind === 'skill').map((r) => r.id);
	const filesByItem = new Map<string, { path: string; content: string }[]>();
	for (const chunk of idChunks(skillIds)) {
		const files = await db
			.selectFrom('context_item_file')
			.select(['context_item_id', 'path', 'content'])
			.where('context_item_id', 'in', chunk)
			.orderBy('path asc')
			.execute();
		for (const f of files) {
			const list = filesByItem.get(f.context_item_id) ?? [];
			list.push({ path: f.path, content: f.content });
			filesByItem.set(f.context_item_id, list);
		}
	}

	// Project names for scope refs, and the projects themselves as anchors.
	const projectRows = await db
		.selectFrom('project')
		.select(['id', 'name', 'description', 'default_workflow_id'])
		.where('user_id', '=', userId)
		.orderBy('name asc')
		.execute();
	const projectNameById = new Map(projectRows.map((p) => [p.id, p.name]));
	const workflowNameById = new Map(workflows.map((w) => [w.id, w]));

	const contextItems: ExportedContextItem[] = exportable.map((r) => {
		const scope: ExportedScope = {
			project: r.project_id === null ? null : (projectNameById.get(r.project_id) ?? null),
			state: r.workflow_state_id === null ? null : (stateRefById.get(r.workflow_state_id) ?? null)
		};
		const item: ExportedContextItem = {
			kind: r.kind as ExportedContextItem['kind'],
			name: r.name,
			description: r.description,
			scope
		};
		if (r.kind === 'prompt') item.body = r.body ?? '';
		if (r.kind === 'skill') item.files = filesByItem.get(r.id) ?? [];
		if (r.kind === 'repo') {
			item.repo_url = r.repo_url ?? '';
			item.repo_branch = r.repo_branch;
			item.repo_dir = r.repo_dir;
		}
		return item;
	});

	// Only projects that exist are exported; the system workflow is never
	// content, so a project defaulting to it exports a null default.
	const projects: ExportedProject[] = projectRows.map((p) => {
		const wf = p.default_workflow_id === null ? undefined : workflowNameById.get(p.default_workflow_id);
		return {
			name: p.name,
			description: p.description,
			default_workflow: wf && !wf.is_system ? wf.name : null
		};
	});

	// Referenced-but-unexported state refs would be unresolvable on import; the
	// system workflow is the only legitimate case, and it is marked as such.
	void systemWorkflow;

	return {
		tines_export: TINES_EXPORT_VERSION,
		exported_at: Date.now(),
		stats: { skipped_issue_scoped: Number(skippedIssueScoped?.n ?? 0) },
		workflows: exportedWorkflows,
		projects,
		context_items: contextItems
	};
}

// ---------------------------------------------------------------------------
// Import

/**
 * Identity keys join on NUL: names are free text, so a printable separator
 * would let one `(kind, name, scope)` tuple forge another's key.
 */
const SEP = String.fromCharCode(0);
const key = (...parts: (string | null)[]) => parts.map((p) => p ?? '').join(SEP);

/** Statements per `runAtomic` batch — well under D1's per-batch ceiling. */
const IMPORT_BATCH = 50;

interface ItemUpdate {
	entry: ImportPlanEntry;
	id: string;
	body: UpdateContextItemRequest;
}

interface PlannedOp {
	entry: ImportPlanEntry;
	queries: CompiledQuery[];
}

interface PlannedImport {
	plan: ImportPlan;
	/** Compiled creates, in apply order: workflows, then projects, then items. */
	creates: PlannedOp[];
	/** Project rows that exist but gain a resolvable default workflow. */
	projectDefaults: PlannedOp[];
	/** Overwrites, applied one call at a time through the normal update path. */
	updates: ItemUpdate[];
}

/** Rejects a document that is not a v1 export before anything reads its entries. */
function validateEnvelope(doc: unknown): ConfigExport {
	if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
		throw new ApiFail(422, 'invalid_document', 'The uploaded file is not a Tines export document');
	}
	const d = doc as Record<string, unknown>;
	if (typeof d.tines_export !== 'number') {
		throw new ApiFail(
			422,
			'invalid_document',
			'The uploaded file is not a Tines export document (no "tines_export" version)'
		);
	}
	if (d.tines_export !== TINES_EXPORT_VERSION) {
		throw new ApiFail(
			422,
			'unsupported_version',
			`This file is export format version ${d.tines_export}; this instance reads version ${TINES_EXPORT_VERSION}`
		);
	}
	for (const field of ['workflows', 'projects', 'context_items'] as const) {
		if (d[field] !== undefined && !Array.isArray(d[field])) {
			throw new ApiFail(422, 'invalid_document', `"${field}" must be an array`);
		}
	}
	return {
		tines_export: TINES_EXPORT_VERSION,
		exported_at: typeof d.exported_at === 'number' ? d.exported_at : 0,
		stats: { skipped_issue_scoped: 0 },
		workflows: (d.workflows as ExportedWorkflow[]) ?? [],
		projects: (d.projects as ExportedProject[]) ?? [],
		context_items: (d.context_items as ExportedContextItem[]) ?? []
	};
}

/** An `ApiFail` from a validator becomes one entry's reason, never a whole-file failure. */
function reasonOf(e: unknown): string {
	if (e instanceof ApiFail) return e.message;
	return e instanceof Error ? e.message : String(e);
}

const countEntries = (entries: ImportPlanEntry[]) => ({
	create: entries.filter((e) => e.action === 'create').length,
	update: entries.filter((e) => e.action === 'update').length,
	skip: entries.filter((e) => e.action === 'skip').length,
	error: entries.filter((e) => e.action === 'error').length
});

/**
 * Plans the merge, compiling every write it would perform. Nothing here
 * writes: `planImport` discards the compiled queries and `applyImport` runs
 * them, so a dry run and its apply reach the same decisions through the same
 * code rather than through two implementations that can drift.
 */
async function planImportInternal(
	db: Kysely<Database>,
	actor: ActorContext,
	input: unknown,
	mode: ImportMode,
	now: number
): Promise<PlannedImport> {
	const doc = validateEnvelope(input);
	const entries: ImportPlanEntry[] = [];
	const creates: PlannedOp[] = [];
	const projectDefaults: PlannedOp[] = [];
	const updates: ItemUpdate[] = [];

	const existingWorkflows = await loadWorkflows(db, actor.userId);
	const existingProjects = await db
		.selectFrom('project')
		.select(['id', 'name', 'default_workflow_id'])
		.where('user_id', '=', actor.userId)
		.execute();
	const existingItems = await db
		.selectFrom('context_item')
		.select(['id', 'kind', 'name', 'project_id', 'workflow_state_id', 'position'])
		.where('user_id', '=', actor.userId)
		.where('issue_id', 'is', null)
		.execute();

	// --- workflows -----------------------------------------------------------
	// State ids by (workflow name, state name), for the scope resolution below.
	// Planned workflows contribute their about-to-be-created ids, so an item
	// scoped to a workflow defined in the same file resolves.
	const userStateIds = new Map<string, string>();
	const systemStateIds = new Map<string, string>();
	for (const wf of existingWorkflows) {
		for (const s of wf.states) {
			if (wf.is_system) systemStateIds.set(s.name, s.id);
			else userStateIds.set(key(wf.name, s.name), s.id);
		}
	}
	const existingWorkflowIdByName = new Map(
		existingWorkflows.filter((w) => !w.is_system).map((w) => [w.name, w.id])
	);
	const workflowIdByName = new Map(existingWorkflowIdByName);

	const seenWorkflowNames = new Set<string>();
	for (const wf of doc.workflows) {
		const name = typeof wf?.name === 'string' ? wf.name.trim() : '';
		const entry: ImportPlanEntry = { type: 'workflow', name, action: 'skip' };
		entries.push(entry);
		if (!name) {
			entry.action = 'error';
			entry.reason = 'A workflow entry has no name';
			continue;
		}
		if (seenWorkflowNames.has(name)) {
			entry.action = 'error';
			entry.reason = 'The file defines this workflow name more than once';
			continue;
		}
		seenWorkflowNames.add(name);
		if (existingWorkflowIdByName.has(name)) {
			// Never overwritten: updateWorkflow replaces the state set, which on
			// a live workflow can delete states and the context attached to them.
			entry.reason = 'A workflow with this name already exists — edit workflows in the app';
			continue;
		}
		try {
			const compiled = createWorkflowQueries(
				db,
				actor,
				{
					name,
					description: wf.description ?? '',
					initial_state: wf.initial_state,
					states: wf.states,
					transitions: wf.transitions ?? []
				},
				now
			);
			entry.action = 'create';
			workflowIdByName.set(name, compiled.id);
			for (const [stateName, id] of compiled.stateIdByName) {
				userStateIds.set(key(name, stateName), id);
			}
			creates.push({
				entry,
				queries: [
					...compiled.queries,
					eventInsert(db, actor, {
						type: 'workflow.created',
						payload: { workflow_id: compiled.id, name }
					})
				]
			});
		} catch (e) {
			entry.action = 'error';
			entry.reason = reasonOf(e);
		}
	}

	// --- projects ------------------------------------------------------------
	const projectIdByName = new Map(existingProjects.map((p) => [p.name, p.id]));
	const seenProjectNames = new Set<string>();
	for (const p of doc.projects) {
		const name = typeof p?.name === 'string' ? p.name.trim() : '';
		const entry: ImportPlanEntry = { type: 'project', name, action: 'skip' };
		entries.push(entry);
		if (!name) {
			entry.action = 'error';
			entry.reason = 'A project entry has no name';
			continue;
		}
		if (seenProjectNames.has(name)) {
			entry.action = 'error';
			entry.reason = 'The file defines this project name more than once';
			continue;
		}
		seenProjectNames.add(name);
		const defaultWorkflowId = p.default_workflow
			? (workflowIdByName.get(p.default_workflow) ?? null)
			: null;
		const existing = existingProjects.find((row) => row.name === name);
		if (existing) {
			// Projects are scope anchors here, not content: an existing one is
			// reused as-is, gaining only a default workflow it does not have.
			if (defaultWorkflowId && existing.default_workflow_id === null) {
				entry.action = 'update';
				entry.reason = `Sets the default workflow to "${p.default_workflow}"`;
				projectDefaults.push({
					entry,
					queries: [
						db
							.updateTable('project')
							.set({ default_workflow_id: defaultWorkflowId, updated_at: now })
							.where('id', '=', existing.id)
							.where('user_id', '=', actor.userId)
							.compile()
					]
				});
			} else {
				entry.reason = 'A project with this name already exists';
			}
			continue;
		}
		const id = newId('prj');
		projectIdByName.set(name, id);
		entry.action = 'create';
		creates.push({
			entry,
			queries: [
				db
					.insertInto('project')
					.values({
						id,
						user_id: actor.userId,
						name,
						description: typeof p.description === 'string' ? p.description : '',
						default_workflow_id: defaultWorkflowId,
						created_at: now,
						updated_at: now
					})
					.compile(),
				eventInsert(db, actor, { type: 'project.created', projectId: id, payload: { name } })
			]
		});
	}

	// --- context items -------------------------------------------------------
	// Positions are appended after whatever the target already holds in the
	// same scope, so relative order survives without copying absolute
	// positions (which would collide with the items already there).
	const nextPosition = new Map<string, number>();
	const existingByIdentity = new Map<string, (typeof existingItems)[number]>();
	for (const row of existingItems) {
		const k = key(row.project_id, row.workflow_state_id);
		nextPosition.set(k, Math.max(nextPosition.get(k) ?? 0, row.position + 1));
		existingByIdentity.set(key(row.kind, row.name, row.project_id, row.workflow_state_id), row);
	}
	const plannedItemKeys = new Set<string>();

	for (const item of doc.context_items) {
		const entry: ImportPlanEntry = {
			type: 'context_item',
			name: typeof item?.name === 'string' ? item.name : '',
			action: 'skip'
		};
		entries.push(entry);

		if (!item || !EXPORTABLE_KINDS.has(item.kind)) {
			entry.action = 'error';
			entry.reason = `Unknown or unsupported context kind "${item?.kind}"`;
			continue;
		}
		const kind = item.kind;

		// Scope: every referent named, resolved against the merged view of what
		// already exists and what this same file creates.
		const scopeIn = item.scope ?? { project: null, state: null };
		let projectId: string | null = null;
		let stateId: string | null = null;
		if (scopeIn.project) {
			projectId = projectIdByName.get(scopeIn.project) ?? null;
			if (!projectId) {
				entry.action = 'error';
				entry.reason = `No project named "${scopeIn.project}"`;
				continue;
			}
		}
		if (scopeIn.state) {
			stateId = scopeIn.state.system
				? (systemStateIds.get(scopeIn.state.state) ?? null)
				: (userStateIds.get(key(scopeIn.state.workflow, scopeIn.state.state)) ?? null);
			if (!stateId) {
				entry.action = 'error';
				entry.reason = scopeIn.state.system
					? `This instance's standard workflow has no state "${scopeIn.state.state}"`
					: `No state "${scopeIn.state.state}" in workflow "${scopeIn.state.workflow}"`;
				continue;
			}
		}
		entry.scope_label = scopeLabel({
			projectName: scopeIn.project ?? null,
			stateName: scopeIn.state?.state ?? null
		});

		let name: string;
		let promptBody: string | null = null;
		let files: ContextFile[] = [];
		let repoUrl = '';
		let repoBranch: string | null = null;
		let repoDir: string | null = null;
		try {
			// The normal create path's validators, so an imported item can never
			// be one this API would itself have refused to create.
			name = validateName(kind, item.name);
			if (kind === 'prompt') promptBody = validatePromptBody(item.body ?? '');
			else if (kind === 'skill') files = validateFiles(item.files ?? []);
			else {
				repoUrl = requireString(item.repo_url, 'repo_url', { max: 1000 }).trim();
				repoBranch = optionalString(item.repo_branch, 'repo_branch', { max: 200 })?.trim() || null;
				repoDir =
					item.repo_dir === undefined || item.repo_dir === null
						? null
						: validateWorkspacePath(item.repo_dir, 'repo_dir');
			}
		} catch (e) {
			entry.action = 'error';
			entry.reason = reasonOf(e);
			continue;
		}
		entry.name = name;

		const identity = key(kind, name, projectId, stateId);
		if (plannedItemKeys.has(identity)) {
			entry.action = 'error';
			entry.reason = 'The file defines this kind, name and scope more than once';
			continue;
		}
		const existing = existingByIdentity.get(identity);
		if (existing) {
			if (mode !== 'overwrite') {
				entry.reason = 'Already present — import in overwrite mode to replace it';
				continue;
			}
			if (isJournal({ ...existing, issue_id: null })) {
				// Journals accumulate lessons and have no history to recover
				// from; overwrite is never allowed to destroy one.
				entry.reason = 'Journals are never overwritten';
				continue;
			}
			entry.action = 'update';
			updates.push({
				entry,
				id: existing.id,
				body: {
					description: typeof item.description === 'string' ? item.description : '',
					...(kind === 'prompt' ? { body: promptBody ?? '' } : {}),
					...(kind === 'skill' ? { files } : {}),
					...(kind === 'repo'
						? { repo_url: repoUrl, repo_branch: repoBranch, repo_dir: repoDir }
						: {})
				}
			});
			continue;
		}

		plannedItemKeys.add(identity);
		const posKey = key(projectId, stateId);
		const position = nextPosition.get(posKey) ?? 0;
		nextPosition.set(posKey, position + 1);
		const id = newId('ctx');
		entry.action = 'create';
		creates.push({
			entry,
			queries: [
				db
					.insertInto('context_item')
					.values({
						id,
						user_id: actor.userId,
						kind,
						name,
						description: typeof item.description === 'string' ? item.description : '',
						project_id: projectId,
						workflow_state_id: stateId,
						issue_id: null,
						body: promptBody,
						repo_url: kind === 'repo' ? repoUrl : null,
						repo_branch: repoBranch,
						repo_dir: repoDir,
						position,
						version: 1,
						created_at: now,
						updated_at: now
					})
					.compile(),
				...files.map((f) =>
					db
						.insertInto('context_item_file')
						.values({
							id: newId('ctf'),
							context_item_id: id,
							path: f.path,
							content: f.content,
							created_at: now,
							updated_at: now
						})
						.compile()
				),
				eventInsert(db, actor, {
					type: 'context.created',
					projectId,
					payload: {
						context_id: id,
						kind,
						name,
						scope: {
							project_id: projectId,
							workflow_state_id: stateId,
							issue_id: null,
							label: entry.scope_label
						}
					}
				})
			]
		});
	}

	return { plan: { mode, entries, counts: countEntries(entries) }, creates, projectDefaults, updates };
}

/** Dry run: what an import would do, computed without writing anything. */
export async function planImport(
	db: Kysely<Database>,
	actor: ActorContext,
	doc: unknown,
	mode: ImportMode
): Promise<ImportPlan> {
	const planned = await planImportInternal(db, actor, doc, mode, Date.now());
	return planned.plan;
}

/**
 * Applies the merge. The plan is recomputed here rather than taken from the
 * client, so the preview the user confirmed is advisory and the write can
 * never act on a plan the server did not just derive from the database.
 *
 * Creates ride chunked `runAtomic` batches. A chunk failing after earlier ones
 * committed leaves a partial import — deliberately, over pretending a
 * multi-batch write is transactional: the merge is idempotent, so re-running
 * the same file converges (everything already applied becomes a skip).
 */
export async function applyImport(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	doc: unknown,
	mode: ImportMode
): Promise<ImportApplyResult> {
	const planned = await planImportInternal(db, actor, doc, mode, Date.now());
	const failed: ImportPlanEntry[] = [];
	let applied = 0;

	// Creates ride in plan order — workflows and projects are compiled before
	// the items that resolve their scope against them.
	const batches: PlannedOp[][] = [];
	let current: PlannedOp[] = [];
	let size = 0;
	for (const op of [...planned.creates, ...planned.projectDefaults]) {
		if (size > 0 && size + op.queries.length > IMPORT_BATCH) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(op);
		size += op.queries.length;
	}
	if (current.length > 0) batches.push(current);

	for (const batch of batches) {
		try {
			await runAtomic(
				env,
				batch.flatMap((op) => op.queries)
			);
			applied += batch.length;
		} catch (e) {
			for (const op of batch) {
				op.entry.action = 'error';
				op.entry.reason = `${reasonOf(e)} — re-run the import to retry; entries already applied will skip`;
				failed.push(op.entry);
			}
		}
	}

	// Overwrites go through the normal update path, so CAS, validation and the
	// context.updated event behave exactly as they do in the app.
	for (const update of planned.updates) {
		try {
			await updateContextItem(db, env, actor, update.id, update.body);
			applied += 1;
		} catch (e) {
			update.entry.action = 'error';
			update.entry.reason = reasonOf(e);
			failed.push(update.entry);
		}
	}

	planned.plan.counts = countEntries(planned.plan.entries);
	return { plan: planned.plan, applied, failed };
}
