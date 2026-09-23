import {
	canonicalizeLibraryValue,
	type ExportWorkflowPackageOptions,
	type WorkflowPackageDocument
} from '@tines/shared';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Database } from '$lib/server/db';
import { sha256Hex } from '$lib/server/crypto';
import { ApiFail, notFound } from '../api/core';
import { loadWorkflows } from '../api/workflows';
import { exportWorkflowPackage } from '../library/export';

export interface PublicationSourceSelection {
	workflowIds: string[];
	stateIds: string[];
	projectId: string | null;
	scheduleIds: string[];
	options: ExportWorkflowPackageOptions;
}

const jsonRows = (query: RawBuilder<unknown>) =>
	sql`(SELECT json_group_array(json(row_json)) FROM (${query}))`;
const ids = (values: string[]) => sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;

/**
 * Resolve the exact owned workflow closure whose rows can affect a public
 * package. IDs stay private: callers store this selection only in the private
 * publication source row and expose the resulting hash in the review proof.
 */
export async function resolvePublicationSourceSelection(
	db: Kysely<Database>,
	userId: string,
	workflowId: string,
	options: ExportWorkflowPackageOptions
): Promise<PublicationSourceSelection> {
	const available = await loadWorkflows(db, userId);
	const main = available.find((workflow) => workflow.id === workflowId);
	if (!main) throw notFound();
	if (main.is_system)
		throw new ApiFail(
			403,
			'publication_source_forbidden',
			'Only an owned workflow can be published'
		);

	const ownerByState = new Map(
		available.flatMap((workflow) => workflow.states.map((state) => [state.id, workflow] as const))
	);
	const closure = new Map([[main.id, main]]);
	const queue = [main];
	for (const workflow of queue)
		for (const state of workflow.states) {
			if (!state.inherits_from) continue;
			const dependency = ownerByState.get(state.inherits_from);
			if (!dependency)
				throw new ApiFail(
					422,
					'missing_dependency',
					`State "${state.name}" has an unavailable inheritance dependency`
				);
			if (!closure.has(dependency.id)) {
				closure.set(dependency.id, dependency);
				queue.push(dependency);
			}
		}

	return {
		workflowIds: [...closure.keys()].sort(),
		stateIds: [...closure.values()]
			.flatMap((workflow) => workflow.states.map((state) => state.id))
			.sort(),
		projectId: options.source_project_id ?? null,
		scheduleIds: [...(options.schedule_ids ?? [])].sort(),
		options: structuredClone(options)
	};
}

/**
 * A single ordered SQL value for every stored row that can change the selected
 * export. The same expression is suitable for a preparation read and for a
 * transaction-time equality guard. Volatile schedule execution counters and
 * unrelated account context are intentionally absent.
 */
export function publicationSourceExpression(
	userId: string,
	selection: PublicationSourceSelection
): RawBuilder<string> {
	const workflowIds = ids(selection.workflowIds);
	const stateIds = ids(selection.stateIds);
	const scheduleIds = ids(selection.scheduleIds);
	const workflows = jsonRows(sql`SELECT json_object(
		'id', w.id, 'user_id', w.user_id, 'name', w.name, 'description', w.description,
		'initial_state_id', w.initial_state_id, 'created_at', w.created_at, 'updated_at', w.updated_at,
		'states', ${jsonRows(sql`SELECT json_object(
			'id', s.id, 'workflow_id', s.workflow_id, 'name', s.name, 'category', s.category,
			'position', s.position, 'inherits_from_state_id', s.inherits_from_state_id,
			'created_at', s.created_at
		) AS row_json FROM workflow_state s WHERE s.workflow_id = w.id ORDER BY s.position, s.id`)},
		'transitions', ${jsonRows(sql`SELECT json_object(
			'id', t.id, 'workflow_id', t.workflow_id, 'name', t.name,
			'from_state_id', t.from_state_id, 'to_state_id', t.to_state_id,
			'requirements', t.requirements
		) AS row_json FROM workflow_transition t WHERE t.workflow_id = w.id ORDER BY t.id`)}
	) AS row_json FROM workflow w
	WHERE w.id IN ${workflowIds} AND (w.user_id = ${userId} OR w.user_id IS NULL)
	ORDER BY w.id`);
	const context = jsonRows(sql`SELECT json_object(
		'id', c.id, 'user_id', c.user_id, 'kind', c.kind, 'name', c.name,
		'description', c.description, 'workflow_state_id', c.workflow_state_id,
		'body', c.body, 'repo_url', c.repo_url, 'repo_branch', c.repo_branch,
		'repo_dir', c.repo_dir, 'config', c.config, 'position', c.position,
		'version', c.version, 'created_at', c.created_at, 'updated_at', c.updated_at,
		'files', ${jsonRows(sql`SELECT json_object(
			'id', f.id, 'path', f.path, 'content', f.content,
			'created_at', f.created_at, 'updated_at', f.updated_at
		) AS row_json FROM context_item_file f WHERE f.context_item_id = c.id ORDER BY f.path, f.id`)}
	) AS row_json FROM context_item c
	WHERE c.user_id = ${userId}
		AND c.workflow_state_id IN ${stateIds}
		AND c.project_id IS NULL AND c.label_id IS NULL AND c.issue_id IS NULL
		AND c.kind NOT IN ('artifact', 'env')
	ORDER BY c.position, c.created_at, c.id`);
	const project = selection.projectId
		? sql`(SELECT json_object('id', p.id, 'user_id', p.user_id, 'name', p.name)
			FROM project p WHERE p.id = ${selection.projectId} AND p.user_id = ${userId})`
		: sql`NULL`;
	const schedules = jsonRows(sql`SELECT json_object(
		'id', s.id, 'project_id', s.project_id, 'name', s.name,
		'title_template', s.title_template, 'description_template', s.description_template,
		'workflow_id', s.workflow_id, 'state_id', s.state_id, 'cron', s.cron,
		'preset', s.preset, 'timezone', s.timezone, 'require_all_closed', s.require_all_closed,
		'created_at', s.created_at, 'updated_at', s.updated_at
	) AS row_json FROM scheduled_task s
	JOIN project p ON p.id = s.project_id AND p.user_id = ${userId}
	WHERE s.id IN ${scheduleIds} AND s.project_id = ${selection.projectId}
	ORDER BY s.created_at, s.id`);

	return sql<string>`json_object(
		'selection', json(${canonicalizeLibraryValue(selection.options)}),
		'workflows', ${workflows}, 'context', ${context},
		'project', ${project}, 'schedules', ${schedules}
	)`;
}

export async function readPublicationSource(
	db: Kysely<Database>,
	userId: string,
	selection: PublicationSourceSelection
): Promise<{ raw: string; fingerprint: string }> {
	const result = await sql<{ projection: string }>`SELECT ${publicationSourceExpression(
		userId,
		selection
	)} AS projection`.execute(db);
	const raw = result.rows[0].projection;
	return { raw, fingerprint: `sha256:${await sha256Hex(raw)}` };
}

/**
 * Build bytes only from a source projection that was stable on both sides of
 * the existing exporter reads. This closes the preparation race without
 * changing private export behavior; confirmation can repeat the operation at
 * the frozen export time and compare both the witness and canonical bytes.
 */
export async function buildOwnedPublicationSourceProof(
	db: Kysely<Database>,
	userId: string,
	workflowId: string,
	options: ExportWorkflowPackageOptions,
	exportedAt = Date.now()
): Promise<{
	document: WorkflowPackageDocument;
	selection: PublicationSourceSelection;
	witnessRaw: string;
	witnessFingerprint: string;
}> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const selection = await resolvePublicationSourceSelection(db, userId, workflowId, options);
		const before = await readPublicationSource(db, userId, selection);
		const document = await exportWorkflowPackage(db, userId, workflowId, options, { exportedAt });
		const afterSelection = await resolvePublicationSourceSelection(db, userId, workflowId, options);
		if (canonicalizeLibraryValue(afterSelection) !== canonicalizeLibraryValue(selection)) continue;
		const after = await readPublicationSource(db, userId, selection);
		if (after.raw !== before.raw) continue;
		return {
			document,
			selection,
			witnessRaw: after.raw,
			witnessFingerprint: after.fingerprint
		};
	}
	throw new ApiFail(
		409,
		'publication_source_changing',
		'The workflow source changed while preparing the publication; review the latest source and retry'
	);
}
