import {
	parseLibraryV3Document,
	diagnosticOf,
	LIBRARY_MAX_BYTES,
	LIBRARY_V3_MAX_RECORDS,
	LIBRARY_V3_MAX_DEPTH,
	type ValidateLibraryResponse
} from '@tines/shared';
import { validateWorkflowCreateFields } from '../api/workflows';
import { validateContextCreateFields } from '../api/context';
import { validateProjectFields } from '../api/projects';
import { normalizeLabelName } from '../api/labels';
import { resolveRecurrence, resolveTimezone } from '../api/schedules';

/** Read-only, destination-independent validation. A saved file stays authoritative after source edits. */
export async function validatePortableLibrary(
	documentJson: string
): Promise<ValidateLibraryResponse> {
	const limits = {
		max_document_bytes: LIBRARY_MAX_BYTES,
		max_records: LIBRARY_V3_MAX_RECORDS,
		max_depth: LIBRARY_V3_MAX_DEPTH
	};
	try {
		const document = await parseLibraryV3Document(documentJson, { allowMissingDigest: true });
		for (const workflow of document.workflows) {
			const names = new Map(workflow.states.map((s) => [s.id, s.name]));
			validateWorkflowCreateFields({
				name: workflow.name,
				description: workflow.description,
				initial_state: names.get(workflow.initial_state_id)!,
				states: workflow.states.map((s) => ({ name: s.name, category: s.category })),
				transitions: workflow.transitions.map((t) => ({
					name: t.name,
					from: names.get(t.from_state_id)!,
					to: names.get(t.to_state_id)!,
					requires: t.requires
				}))
			});
		}
		for (const item of document.context)
			validateContextCreateFields({
				kind: item.kind,
				name: item.name,
				description: item.description,
				...(item.kind === 'prompt'
					? { body: item.body }
					: item.kind === 'skill'
						? { files: item.files.map(({ path, content }) => ({ path, content })) }
						: { repo_url: item.repo_url, repo_branch: item.repo_branch, repo_dir: item.repo_dir })
			});
		if (document.profile === 'library') {
			for (const project of document.projects) validateProjectFields(project);
			for (const label of document.labels) normalizeLabelName(label.name);
		} else
			for (const schedule of document.schedules) {
				resolveRecurrence(
					schedule.recurrence.kind === 'preset'
						? { preset: schedule.recurrence.preset }
						: { cron: schedule.recurrence.cron }
				);
				resolveTimezone(schedule.timezone);
			}
		return { valid: true, digest: document.digest, document, diagnostics: [], limits };
	} catch (error) {
		return { valid: false, digest: null, diagnostics: diagnosticOf(error), limits };
	}
}
