import {
	inputToken,
	type PackageInput,
	type TextUseField,
	type WorkflowPackageDocument
} from '@tines/shared';
import { declaredOccurrences } from './package-text';

export type InputDraft = {
	key: string;
	type: PackageInput['type'];
	label: string;
	description: string;
	default: string;
	required: boolean;
};

export function normalizeInputDraft(draft: InputDraft) {
	const key = draft.key.trim();
	if (!/^[a-z][a-z0-9_]{0,63}$/.test(key))
		throw new Error(
			'Use a lowercase input key beginning with a letter and containing only letters, numbers, or underscores.'
		);
	return {
		key,
		type: draft.type,
		label: draft.label.trim() || key,
		description: draft.description,
		required: draft.required,
		default: draft.default === '' ? null : draft.default
	} satisfies Pick<PackageInput, 'key' | 'type' | 'label' | 'description' | 'required' | 'default'>;
}

export function readField(
	document: WorkflowPackageDocument,
	recordId: string,
	field: TextUseField
): string | undefined {
	for (const workflow of document.workflows)
		if (workflow.id === recordId && field === 'description') return workflow.description;
	for (const item of document.context) {
		if (item.id === recordId && field === 'description') return item.description;
		if (item.id === recordId && item.kind === 'prompt' && field === 'body') return item.body;
		if (item.kind === 'skill')
			for (const file of item.files)
				if (file.id === recordId && field === 'content') return file.content;
	}
	for (const schedule of document.schedules)
		if (schedule.id === recordId) {
			if (field === 'title_template') return schedule.title_template;
			if (field === 'description_template') return schedule.description_template;
		}
	return undefined;
}

export function writeField(
	document: WorkflowPackageDocument,
	recordId: string,
	field: TextUseField,
	value: string
): boolean {
	for (const workflow of document.workflows)
		if (workflow.id === recordId && field === 'description') {
			workflow.description = value;
			return true;
		}
	for (const item of document.context) {
		if (item.id === recordId && field === 'description') {
			item.description = value;
			return true;
		}
		if (item.id === recordId && item.kind === 'prompt' && field === 'body') {
			item.body = value;
			return true;
		}
		if (item.kind === 'skill')
			for (const file of item.files)
				if (file.id === recordId && field === 'content') {
					file.content = value;
					return true;
				}
	}
	for (const schedule of document.schedules)
		if (schedule.id === recordId) {
			if (field === 'title_template') {
				schedule.title_template = value;
				return true;
			}
			if (field === 'description_template') {
				schedule.description_template = value;
				return true;
			}
		}
	return false;
}

export function updateAuthoredInput(
	document: WorkflowPackageDocument,
	inputId: string,
	draft: InputDraft
): WorkflowPackageDocument {
	const index = document.inputs.findIndex((input) => input.id === inputId);
	if (index < 0) throw new Error('Input declaration no longer exists.');
	if (!inputId.startsWith('input:author:'))
		throw new Error('Generated input declarations are read-only.');

	const current = document.inputs[index];
	const normalized = normalizeInputDraft(draft);
	if (
		document.inputs.some(
			(input, candidateIndex) => candidateIndex !== index && input.key === normalized.key
		)
	)
		throw new Error(`Input key “${normalized.key}” already exists.`);
	if (current.required_states && normalized.type !== 'workflow')
		throw new Error('An input with required workflow states must keep the workflow type.');

	const next = structuredClone(document);
	next.inputs[index] = { ...next.inputs[index], ...normalized };
	const oldToken = inputToken(current.key, current.default);
	const newToken = inputToken(normalized.key, normalized.default);
	if (oldToken === newToken) return next;

	const groups = new Map<string, { recordId: string; field: TextUseField }>();
	for (const use of next.text_uses) {
		if (use.input_id !== inputId) continue;
		if (use.token !== oldToken)
			throw new Error(`Registered use “${use.id}” does not match this input's current token.`);
		groups.set(`${use.target.record_id}\0${use.target.field}`, {
			recordId: use.target.record_id,
			field: use.target.field
		});
	}

	for (const { recordId, field } of groups.values()) {
		const source = readField(next, recordId, field);
		if (source === undefined)
			throw new Error('A registered token use targets a missing candidate field.');
		const occurrences = declaredOccurrences(source, [{ token: oldToken, inputId }]);
		if (!occurrences.length)
			throw new Error('A registered token use has no active occurrence in its candidate field.');
		let value = '';
		let offset = 0;
		for (const occurrence of occurrences) {
			value += source.slice(offset, occurrence.start) + newToken;
			offset = occurrence.end;
		}
		value += source.slice(offset);
		if (!writeField(next, recordId, field, value))
			throw new Error('A registered token use targets a missing candidate field.');
	}
	for (const use of next.text_uses) if (use.input_id === inputId) use.token = newToken;
	return next;
}
