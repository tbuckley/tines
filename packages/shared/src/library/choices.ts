import { LABEL_COLORS, LABEL_NAME_MAX, MODEL_TIERS } from '../types.js';
import { invalid, pointer, validateUnicode } from './schema.js';
import { canonicalizeLibraryValue } from './canonical.js';
import type { WorkflowPackageChoices, WorkflowPackageDocument } from './types.js';

export const PACKAGE_CHOICES_MAX_BYTES = 512 * 1024;
function record(value: unknown, path: string): Record<string, unknown> {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		![null, Object.prototype].includes(Object.getPrototypeOf(value))
	)
		invalid(path, 'invalid_choices', 'Expected a plain object');
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], path: string) {
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) invalid(pointer(path, key), 'unknown_choice', 'Unknown choice');
}
function text(value: unknown, path: string, max: number) {
	if (typeof value !== 'string' || value.length > max)
		invalid(path, 'invalid_choices', `Expected text of at most ${max} characters`);
	validateUnicode(value, path);
}
/** Strict wire shape and document-local identity boundary for preparation. */
export function validatePackageChoices(
	value: unknown,
	document: WorkflowPackageDocument
): WorkflowPackageChoices {
	const choices = record(value, '/choices');
	keys(
		choices,
		['workflow_names', 'schedule_names', 'inputs', 'schedule_ids', 'routing'],
		'/choices'
	);
	for (const [field, ids] of [
		['workflow_names', document.workflows.map((w) => w.id)],
		['schedule_names', document.schedules.map((s) => s.id)],
		['routing', document.routing.map((r) => r.id)],
		['inputs', document.inputs.map((i) => i.id)]
	] as const) {
		if (!Object.hasOwn(choices, field)) continue;
		const map = record(choices[field], `/choices/${field}`);
		keys(map, ids, `/choices/${field}`);
		for (const [id, choice] of Object.entries(map)) {
			const path = pointer(`/choices/${field}`, id);
			if (field === 'routing') {
				if (!MODEL_TIERS.includes(choice as never))
					invalid(path, 'invalid_choices', 'Unknown destination tier');
			} else if (field === 'inputs') {
				const input = document.inputs.find((i) => i.id === id)!;
				const object = record(choice, path);
				if (input.type === 'text') {
					keys(object, ['value'], path);
					text(object.value, `${path}/value`, 10000);
				} else if (object.mode === 'reuse') {
					keys(object, ['mode', 'id'], path);
					text(object.id, `${path}/id`, 100);
					if (!(object.id as string).trim())
						invalid(path, 'invalid_choices', 'Select a destination object ID');
				} else if (input.type === 'label' && object.mode === 'create') {
					keys(object, ['mode', 'name', 'color'], path);
					text(object.name, `${path}/name`, LABEL_NAME_MAX);
					if (!LABEL_COLORS.includes(object.color as never))
						invalid(path, 'invalid_choices', 'Unknown label color');
				} else
					invalid(
						path,
						'invalid_choices',
						`Input ${input.key} requires an existing destination ${input.type}`
					);
			} else {
				text(choice, path, 200);
				if (!(choice as string).trim()) invalid(path, 'invalid_choices', 'Name must not be empty');
			}
		}
	}
	if (Object.hasOwn(choices, 'schedule_ids')) {
		const ids = choices.schedule_ids;
		if (
			!Array.isArray(ids) ||
			ids.some((id) => typeof id !== 'string' || !document.schedules.some((s) => s.id === id)) ||
			new Set(ids).size !== ids.length
		)
			invalid('/choices/schedule_ids', 'invalid_choices', 'Select unique document schedule IDs');
	}
	const encoded = canonicalizeLibraryValue(choices);
	if (new TextEncoder().encode(encoded).length > PACKAGE_CHOICES_MAX_BYTES)
		invalid('/choices', 'package_too_large', 'Choices exceed 512 KiB');
	return JSON.parse(encoded) as WorkflowPackageChoices;
}
