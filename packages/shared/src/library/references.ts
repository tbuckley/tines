import {
	LibraryValidationError,
	LIBRARY_V3_MAX_RECORDS,
	type WorkflowPackageDocument
} from './types.js';

const LOCAL_ID = /^[A-Za-z0-9:_-]{1,80}$/;

export function validateWorkflowPackageReferences(document: WorkflowPackageDocument): void {
	const diagnostics: { path: string; code: string; message: string }[] = [];
	const ids = new Map<string, string>();
	const add = (id: string, path: string) => {
		if (!LOCAL_ID.test(id))
			diagnostics.push({
				path,
				code: 'invalid_local_id',
				message: 'Local IDs must be 1–80 ASCII letters, digits, colon, underscore or hyphen'
			});
		const first = ids.get(id);
		if (first)
			diagnostics.push({
				path,
				code: 'duplicate_local_id',
				message: `Local ID already used at ${first}`
			});
		else ids.set(id, path);
	};
	for (const [wi, workflow] of document.workflows.entries()) {
		add(workflow.id, `/workflows/${wi}/id`);
		const states = new Set(workflow.states.map((state) => state.id));
		for (const [si, state] of workflow.states.entries())
			add(state.id, `/workflows/${wi}/states/${si}/id`);
		if (!states.has(workflow.initial_state_id))
			diagnostics.push({
				path: `/workflows/${wi}/initial_state_id`,
				code: 'invalid_reference',
				message: 'Initial state must belong to its workflow'
			});
		for (const [ti, transition] of workflow.transitions.entries()) {
			add(transition.id, `/workflows/${wi}/transitions/${ti}/id`);
			for (const [field, ref] of [
				['from_state_id', transition.from_state_id],
				['to_state_id', transition.to_state_id]
			] as const) {
				if (!states.has(ref))
					diagnostics.push({
						path: `/workflows/${wi}/transitions/${ti}/${field}`,
						code: 'invalid_reference',
						message: 'Transition state must belong to its workflow'
					});
			}
		}
	}
	for (const [ci, item] of document.context.entries()) {
		add(item.id, `/context/${ci}/id`);
		if (item.kind === 'skill')
			for (const [fi, file] of item.files.entries()) add(file.id, `/context/${ci}/files/${fi}/id`);
	}
	for (const [group, records] of [
		['inputs', document.inputs],
		['text_uses', document.text_uses],
		['schedules', document.schedules],
		['routing', document.routing]
	] as const) {
		for (const [index, record] of records.entries()) add(record.id, `/${group}/${index}/id`);
	}
	if (!document.workflows.some((workflow) => workflow.id === document.main_workflow_id))
		diagnostics.push({
			path: '/main_workflow_id',
			code: 'invalid_reference',
			message: 'Main workflow does not exist'
		});
	const recordCount = ids.size;
	if (recordCount > LIBRARY_V3_MAX_RECORDS)
		diagnostics.push({
			path: '',
			code: 'package_too_large',
			message: `Package contains ${recordCount} records; maximum is ${LIBRARY_V3_MAX_RECORDS}`
		});
	if (diagnostics.length) throw new LibraryValidationError(diagnostics);
}
