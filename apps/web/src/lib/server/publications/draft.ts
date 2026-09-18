import {
	canonicalizeLibraryValue,
	withLibraryDocumentDigest,
	type PackageInput,
	type TextUse,
	type TextUseField,
	type WorkflowPackageDocument
} from '@tines/shared';

export class PublicationDraftError extends Error {
	constructor(public readonly path: string) {
		super(`Publication draft changes a protected field at ${path || '/'}`);
	}
}

const clone = <T>(value: T): T => structuredClone(value);
const equal = (left: unknown, right: unknown) =>
	canonicalizeLibraryValue(left) === canonicalizeLibraryValue(right);

function firstDifference(left: unknown, right: unknown, path = ''): string {
	if (equal(left, right)) return '';
	if (
		left === null ||
		right === null ||
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		Array.isArray(left) !== Array.isArray(right)
	)
		return path;
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
	for (const key of keys) {
		const child = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
		if (!Object.hasOwn(leftRecord, key) || !Object.hasOwn(rightRecord, key)) return child;
		const difference = firstDifference(leftRecord[key], rightRecord[key], child);
		if (difference) return difference;
	}
	return path;
}

function editableFields(document: WorkflowPackageDocument) {
	const fields = new Map<string, { owner: Record<string, unknown>; field: TextUseField }>();
	const add = (id: string, owner: object, field: TextUseField) =>
		fields.set(`${id}\0${field}`, { owner: owner as Record<string, unknown>, field });
	for (const workflow of document.workflows) add(workflow.id, workflow, 'description');
	for (const item of document.context) {
		add(item.id, item, 'description');
		if (item.kind === 'prompt') add(item.id, item, 'body');
		if (item.kind === 'skill') for (const file of item.files) add(file.id, file, 'content');
	}
	for (const schedule of document.schedules) {
		add(schedule.id, schedule, 'title_template');
		add(schedule.id, schedule, 'description_template');
	}
	return fields;
}

function authoredTail<T extends PackageInput | TextUse>(
	baseline: T[],
	submitted: T[],
	prefix: 'input:author:' | 'use:author:',
	path: string
) {
	if (submitted.length < baseline.length || !equal(submitted.slice(0, baseline.length), baseline))
		throw new PublicationDraftError(path);
	const tail = submitted.slice(baseline.length);
	const invalid = tail.findIndex((item) => !item.id.startsWith(prefix));
	if (invalid >= 0) throw new PublicationDraftError(`${path}/${baseline.length + invalid}/id`);
	return clone(tail);
}

/** Admit only browser-authored text, declarations, and registered text uses. */
export async function deriveOwnedPublicationDraft(
	baseline: WorkflowPackageDocument,
	submitted: WorkflowPackageDocument,
	exportedAt: number
): Promise<WorkflowPackageDocument> {
	if (submitted.exported_at !== baseline.exported_at)
		throw new PublicationDraftError('/exported_at');
	const expected = clone(baseline);
	const sourceFields = editableFields(submitted);
	for (const [key, target] of editableFields(expected)) {
		const source = sourceFields.get(key);
		if (!source) throw new PublicationDraftError('/context');
		target.owner[target.field] = source.owner[source.field];
	}
	expected.inputs = [
		...clone(baseline.inputs),
		...authoredTail(baseline.inputs, submitted.inputs, 'input:author:', '/inputs')
	];
	expected.text_uses = [
		...clone(baseline.text_uses),
		...authoredTail(baseline.text_uses, submitted.text_uses, 'use:author:', '/text_uses')
	];
	expected.digest = submitted.digest;
	const difference = firstDifference(expected, submitted);
	if (difference) throw new PublicationDraftError(difference);
	return withLibraryDocumentDigest({ ...expected, exported_at: exportedAt });
}
