import {
	withLibraryDocumentDigest,
	type LibraryV3Document,
	type LibraryV3Context,
	type BundledStateRef,
	type SystemStateRef
} from '@tines/shared';
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { contextItemQuery, isJournal, loadFiles } from './context';
import { loadWorkflows } from './workflows';
import type { BuildLibraryOptions } from './library';

/** ID-addressed whole-library exporter. Keep the public default legacy until the v3 reader/UI land. */
export async function buildLibraryV3Document(
	db: Kysely<Database>,
	userId: string,
	{ includeJournals = true }: BuildLibraryOptions = {}
): Promise<LibraryV3Document> {
	const [allWorkflows, projects, labels, rows] = await Promise.all([
		loadWorkflows(db, userId),
		db
			.selectFrom('project')
			.select(['id', 'name', 'description', 'default_workflow_id'])
			.where('user_id', '=', userId)
			.orderBy('created_at')
			.orderBy('id')
			.execute(),
		db
			.selectFrom('label')
			.select(['id', 'name', 'color'])
			.where('user_id', '=', userId)
			.orderBy('created_at')
			.orderBy('id')
			.execute(),
		contextItemQuery(db, userId)
			.where('context_item.issue_id', 'is', null)
			.where('context_item.kind', '!=', 'artifact')
			.orderBy('context_item.position')
			.orderBy('context_item.created_at')
			.orderBy('context_item.id')
			.execute()
	]);
	const owned = allWorkflows
		.filter((w) => !w.is_system)
		.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
	const workflowIds = new Map(owned.map((w, i) => [w.id, `workflow:${i + 1}`]));
	const workflowRef = (
		id: string | null
	): LibraryV3Document['projects'][number]['default_workflow'] => {
		if (id === null) return null;
		const local = workflowIds.get(id);
		if (local) return { kind: 'bundled_workflow', workflow_id: local };
		if (
			allWorkflows.some(
				(workflow) => workflow.id === id && workflow.is_system && workflow.name === 'Standard'
			)
		)
			return { kind: 'system_workflow', name: 'Standard' };
		throw Error('Project default workflow is outside the exportable library');
	};
	const projectIds = new Map(projects.map((p, i) => [p.id, `project:${i + 1}`]));
	const labelIds = new Map(labels.map((l, i) => [l.id, `label:${i + 1}`]));
	const stateRefs = new Map<string, BundledStateRef | SystemStateRef>();
	let stateCount = 0;
	for (const w of [...owned, ...allWorkflows.filter((w) => w.is_system)]) {
		for (const state of [...w.states].sort(
			(a, b) => a.position - b.position || a.id.localeCompare(b.id)
		)) {
			stateRefs.set(
				state.id,
				w.is_system
					? { kind: 'system_state', workflow: 'Standard', state_name: state.name }
					: { kind: 'bundled_state', state_id: `state:${++stateCount}` }
			);
		}
	}
	const stateId = (id: string) => {
		const ref = stateRefs.get(id);
		if (ref?.kind !== 'bundled_state') throw Error('Missing bundled state in library export');
		return ref.state_id;
	};
	let transitionCount = 0;
	const kept = rows.filter((row) => includeJournals || !isJournal(row));
	const files = await loadFiles(
		db,
		kept.filter((row) => row.kind === 'skill').map((row) => row.id)
	);
	let fileCount = 0;
	const context: LibraryV3Context[] = kept.map((row, i) => {
		const common = {
			id: `context:${i + 1}`,
			name: row.name,
			description: row.description,
			journal: isJournal(row),
			scope: {
				...(row.project_id ? { project_id: projectIds.get(row.project_id)! } : {}),
				...(row.workflow_state_id ? { state: stateRefs.get(row.workflow_state_id)! } : {}),
				...(row.label_id ? { label_id: labelIds.get(row.label_id)! } : {})
			}
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
	return withLibraryDocumentDigest({
		format: 'tines.library',
		version: 3,
		profile: 'library',
		exported_at: Date.now(),
		digest: '',
		workflows: owned.map((w) => ({
			id: workflowIds.get(w.id)!,
			name: w.name,
			description: w.description,
			initial_state_id: stateId(w.initial_state_id),
			states: [...w.states]
				.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
				.map((state) => ({
					id: stateId(state.id),
					name: state.name,
					category: state.category,
					inherits_from: state.inherits_from ? stateRefs.get(state.inherits_from)! : null
				})),
			transitions: [...w.transitions]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((transition) => ({
					id: `transition:${++transitionCount}`,
					name: transition.name,
					from_state_id: stateId(transition.from_state_id),
					to_state_id: stateId(transition.to_state_id),
					requires: transition.requires ?? []
				}))
		})),
		projects: projects.map((p) => ({
			id: projectIds.get(p.id)!,
			name: p.name,
			description: p.description,
			default_workflow: workflowRef(p.default_workflow_id)
		})),
		labels: labels.map((label) => ({
			id: labelIds.get(label.id)!,
			name: label.name,
			color: label.color as LibraryV3Document['labels'][number]['color']
		})),
		context
	});
}
