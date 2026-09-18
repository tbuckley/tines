import { renderDeclaredTokens } from './inputs.js';
import { validateLibraryV3References } from './references.js';
import { invalid, validateLibraryV3Shape, validateUnicode } from './schema.js';
import type { TextUseField, WorkflowPackageDocument } from './types.js';

export interface RenderedPackageField {
	record_id: string;
	field: TextUseField;
	original: string;
	rendered: string;
	uses: { id: string; input_id: string; count: number }[];
}

/**
 * Values are text or already authorized destination display names, never IDs.
 * Returns reviewable patches, not a falsely digest-bearing modified document.
 */
export function renderPackageFields(
	document: WorkflowPackageDocument,
	values: Readonly<Record<string, string>>
): RenderedPackageField[] {
	validateLibraryV3References(document);
	for (const [id, value] of Object.entries(values)) {
		if (!document.inputs.some((input) => input.id === id))
			invalid(`/inputs/${id}`, 'unknown_input', 'Unknown input value');
		if (typeof value !== 'string' || value.length > 10000)
			invalid(
				`/inputs/${id}`,
				'invalid_input_value',
				'Resolved input values must be strings of at most 10000 characters'
			);
		validateUnicode(value, `/inputs/${id}`);
	}
	const rendered = structuredClone(document);
	const records = new Map<string, Record<string, unknown>>();
	for (const record of [...rendered.workflows, ...rendered.context, ...rendered.schedules])
		records.set(record.id, record as unknown as Record<string, unknown>);
	for (const item of rendered.context)
		if (item.kind === 'skill')
			for (const file of item.files)
				records.set(file.id, file as unknown as Record<string, unknown>);
	const groups = new Map<string, typeof document.text_uses>();
	for (const use of document.text_uses) {
		if (!Object.hasOwn(values, use.input_id))
			invalid(
				`/text_uses/${use.id}`,
				'missing_input_value',
				'A declared use requires a resolved value'
			);
		const key = JSON.stringify([use.target.record_id, use.target.field]);
		const group = groups.get(key) ?? [];
		group.push(use);
		groups.set(key, group);
	}
	const result: RenderedPackageField[] = [];
	for (const group of groups.values()) {
		const target = group[0].target;
		const record = records.get(target.record_id)!;
		const original = record[target.field] as string;
		const { value, counts } = renderDeclaredTokens(
			original,
			group.map((use) => ({ token: use.token, value: values[use.input_id] }))
		);
		record[target.field] = value;
		result.push({
			record_id: target.record_id,
			field: target.field,
			original,
			rendered: value,
			uses: group.map((use, i) => ({ id: use.id, input_id: use.input_id, count: counts[i] }))
		});
	}
	// Domain payload caps apply after all substitutions, including combined skill bytes.
	validateLibraryV3Shape(rendered);
	return result;
}
