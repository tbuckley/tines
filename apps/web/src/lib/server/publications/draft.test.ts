import { describe, expect, it } from 'vitest';
import { inputToken, withLibraryDocumentDigest } from '@tines/shared';
import { inheritedPackage } from '../../../../../../packages/shared/src/library/fixtures';
import { deriveOwnedPublicationDraft, PublicationDraftError } from './draft';

async function baseline() {
	return withLibraryDocumentDigest(inheritedPackage());
}

describe('owned publication drafts', () => {
	it('freezes authored declarations, exact uses, and allowed text without mutating inputs', async () => {
		const clean = await baseline();
		const submitted = structuredClone(clean);
		const input = {
			id: 'input:author:1',
			key: 'project_name',
			type: 'text' as const,
			label: 'Project name',
			description: '',
			required: true,
			default: 'billing-service'
		};
		const token = inputToken(input.key, input.default);
		submitted.inputs.push(input);
		submitted.context[0].description = '';
		if (submitted.context[0].kind !== 'prompt') throw new Error('fixture changed');
		submitted.context[0].body = `${token} customer-portal {{filing_label:qa}}`;
		submitted.text_uses.push({
			id: 'use:author:1',
			target: { record_id: submitted.context[0].id, field: 'body' },
			input_id: input.id,
			token
		});
		const sealed = await withLibraryDocumentDigest(submitted);
		const result = await deriveOwnedPublicationDraft(clean, sealed, 2000);

		expect(result.exported_at).toBe(2000);
		expect(result.inputs.at(-1)).toEqual(input);
		expect(result.text_uses.at(-1)?.id).toBe('use:author:1');
		expect(result.context[0]).toMatchObject({
			body: `${token} customer-portal {{filing_label:qa}}`
		});
		expect(clean).toEqual(await baseline());
		expect(sealed.exported_at).toBe(clean.exported_at);
	});

	it.each([
		[
			'workflow name',
			(draft: Awaited<ReturnType<typeof baseline>>) => (draft.workflows[0].name = 'Changed')
		],
		['record order', (draft: Awaited<ReturnType<typeof baseline>>) => draft.context.reverse()],
		[
			'generated input',
			(draft: Awaited<ReturnType<typeof baseline>>) => (draft.inputs[0].label = 'Changed')
		]
	])('rejects protected %s changes', async (_name, mutate) => {
		const clean = await baseline();
		const submitted = structuredClone(clean);
		mutate(submitted);
		const sealed = await withLibraryDocumentDigest(submitted);
		await expect(deriveOwnedPublicationDraft(clean, sealed, 2000)).rejects.toBeInstanceOf(
			PublicationDraftError
		);
	});

	it('rejects a draft rebound to another baseline timestamp', async () => {
		const clean = await baseline();
		const submitted = await withLibraryDocumentDigest({
			...clean,
			exported_at: clean.exported_at + 1
		});
		await expect(deriveOwnedPublicationDraft(clean, submitted, 2000)).rejects.toMatchObject({
			path: '/exported_at'
		});
	});
});
