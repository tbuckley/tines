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

export type EditablePackageField = {
	key: string;
	recordId: string;
	field: TextUseField;
	label: string;
	value: string;
};

export type FieldRef = { recordId: string; field: TextUseField };

export type ReplaceSelectionRequest = {
	ref: FieldRef;
	sourceSnapshot: string;
	value?: string;
	start: number;
	end: number;
	inputId?: string;
	newInput?: InputDraft;
};

export type ReplaceSelectionResult = {
	document: WorkflowPackageDocument;
	inputId: string;
	useId: string;
	occurrence: { recordId: string; field: TextUseField; useId: string; ordinal: number };
	selection: { start: number; end: number };
};

/** Every field that can carry a registered package input, in review order. */
export function listEditableFields(document: WorkflowPackageDocument): EditablePackageField[] {
	const fields: EditablePackageField[] = [];
	for (const workflow of document.workflows)
		fields.push({
			key: `${workflow.id}:description`,
			recordId: workflow.id,
			field: 'description',
			label: `${workflow.name} — description`,
			value: workflow.description
		});
	for (const item of document.context) {
		fields.push({
			key: `${item.id}:description`,
			recordId: item.id,
			field: 'description',
			label: `${item.name} — description`,
			value: item.description
		});
		if (item.kind === 'prompt')
			fields.push({
				key: `${item.id}:body`,
				recordId: item.id,
				field: 'body',
				label: `${item.name} — prompt body`,
				value: item.body
			});
		if (item.kind === 'skill')
			for (const file of item.files)
				fields.push({
					key: `${file.id}:content`,
					recordId: file.id,
					field: 'content',
					label: `${item.name} / ${file.path}`,
					value: file.content
				});
	}
	for (const schedule of document.schedules) {
		fields.push({
			key: `${schedule.id}:title_template`,
			recordId: schedule.id,
			field: 'title_template',
			label: `${schedule.name} — title template`,
			value: schedule.title_template
		});
		fields.push({
			key: `${schedule.id}:description_template`,
			recordId: schedule.id,
			field: 'description_template',
			label: `${schedule.name} — description template`,
			value: schedule.description_template
		});
	}
	return fields;
}

export function generateInputKey(label: string, usedKeys: readonly string[]): string {
	let base = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (!base) base = 'variable';
	if (/^[0-9]/.test(base)) base = `variable_${base}`;
	base = base.slice(0, 64).replace(/_+$/g, '') || 'variable';
	const used = new Set(usedKeys);
	if (!used.has(base)) return base;
	for (let suffix = 2; ; suffix++) {
		const ending = `_${suffix}`;
		const candidate = `${base.slice(0, 64 - ending.length).replace(/_+$/g, '')}${ending}`;
		if (!used.has(candidate)) return candidate;
	}
}

export function nextAuthoredId(
	document: WorkflowPackageDocument,
	prefix: 'input:author:' | 'use:author:'
): string {
	const ids = new Set([
		...document.workflows.map((record) => record.id),
		...document.context.flatMap((record) => [
			record.id,
			...(record.kind === 'skill' ? record.files.map((file) => file.id) : [])
		]),
		...document.schedules.map((record) => record.id),
		...document.routing.map((record) => record.id),
		...document.inputs.map((record) => record.id),
		...document.text_uses.map((record) => record.id)
	]);
	for (let index = 1; ; index++) if (!ids.has(`${prefix}${index}`)) return `${prefix}${index}`;
}

function cutsSurrogatePair(value: string, offset: number) {
	if (offset <= 0 || offset >= value.length) return false;
	const before = value.charCodeAt(offset - 1);
	const after = value.charCodeAt(offset);
	return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Atomically create/reuse a declaration and replace the captured exact range. */
export function replaceSelectionWithVariable(
	document: WorkflowPackageDocument,
	request: ReplaceSelectionRequest
): ReplaceSelectionResult {
	const current = readField(document, request.ref.recordId, request.ref.field);
	if (current === undefined) throw new Error('The selected passage no longer exists.');
	if (current !== request.sourceSnapshot)
		throw new Error('This passage changed. Select the text again before making a variable.');
	const source = request.value ?? current;
	if (
		request.start < 0 ||
		request.end > source.length ||
		request.start >= request.end ||
		cutsSurrogatePair(source, request.start) ||
		cutsSurrogatePair(source, request.end)
	)
		throw new Error('Select a complete, non-empty text range.');

	const fieldUses = document.text_uses.filter(
		(use) => use.target.record_id === request.ref.recordId && use.target.field === request.ref.field
	);
	const occurrences = declaredOccurrences(
		source,
		fieldUses.map((use) => ({ token: use.token, inputId: use.input_id }))
	);
	if (
		occurrences.some(
			(occurrence) => request.start < occurrence.end && request.end > occurrence.start
		)
	)
		throw new Error('Select ordinary passage text, or edit the existing variable chip.');

	const next = JSON.parse(JSON.stringify(document)) as WorkflowPackageDocument;
	let input: PackageInput | undefined;
	if (request.inputId) input = next.inputs.find((item) => item.id === request.inputId);
	else if (request.newInput) {
		const normalized = normalizeInputDraft(request.newInput);
		if (next.inputs.some((item) => item.key === normalized.key))
			throw new Error(`Input key “${normalized.key}” already exists.`);
		input = { id: nextAuthoredId(next, 'input:author:'), ...normalized };
		next.inputs.push(input);
	}
	if (!input) throw new Error('Choose an existing variable or create a new one.');

	const token = inputToken(input.key, input.default);
	const existingUse = fieldUses.find((use) => use.input_id === input!.id);
	// Registering a use row would activate any unescaped literal copy of the token
	// already in this passage; an escaped copy (`\{{key:default}}`) stays literal.
	if (!existingUse && declaredOccurrences(source, [{ token, inputId: input.id }]).length)
		throw new Error(
			'This token already appears here. Choose New variable or escape the literal token.'
		);
	const value = `${source.slice(0, request.start)}${token}${source.slice(request.end)}`;
	if (!writeField(next, request.ref.recordId, request.ref.field, value))
		throw new Error('The selected passage no longer exists.');
	let use = next.text_uses.find(
		(item) =>
			item.input_id === input!.id &&
			item.target.record_id === request.ref.recordId &&
			item.target.field === request.ref.field
	);
	if (!use) {
		use = {
			id: nextAuthoredId(next, 'use:author:'),
			target: { record_id: request.ref.recordId, field: request.ref.field },
			input_id: input.id,
			token
		};
		next.text_uses.push(use);
	}
	const ordinal = declaredOccurrences(value, [{ token, inputId: input.id }]).findIndex(
		(occurrence) => occurrence.start === request.start
	);
	if (ordinal < 0) throw new Error('The new variable occurrence could not be located.');
	return {
		document: next,
		inputId: input.id,
		useId: use.id,
		occurrence: {
			recordId: request.ref.recordId,
			field: request.ref.field,
			useId: use.id,
			ordinal
		},
		selection: { start: request.start, end: request.start + token.length }
	};
}

export function saveAuthoredField(
	document: WorkflowPackageDocument,
	ref: FieldRef,
	value: string
): WorkflowPackageDocument {
	const next = JSON.parse(JSON.stringify(document)) as WorkflowPackageDocument;
	if (!writeField(next, ref.recordId, ref.field, value))
		throw new Error('The selected passage no longer exists.');
	for (const use of next.text_uses.filter(
		(item) => item.target.record_id === ref.recordId && item.target.field === ref.field
	)) {
		if (declaredOccurrences(value, [{ token: use.token, inputId: use.input_id }]).length) continue;
		if (!use.id.startsWith('use:author:'))
			throw new Error('This edit would remove a required generated variable use.');
		next.text_uses = next.text_uses.filter((item) => item.id !== use.id);
	}
	return next;
}

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

	// Svelte's candidate is a deep reactive proxy in the browser. Package documents
	// are strict JSON, so a JSON round-trip gives the helper a detached plain value
	// without asking structuredClone to clone that proxy.
	const next = JSON.parse(JSON.stringify(document)) as WorkflowPackageDocument;
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
