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
import type { ConfigExport, ExportedContextItem, ExportedProject, ExportedScope, ExportedWorkflow } from '@tines/shared';
import { TINES_EXPORT_VERSION } from '@tines/shared';
import type { Kysely } from 'kysely';
import { idChunks, type Database } from '$lib/server/db';
import { loadWorkflows } from './workflows';

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
