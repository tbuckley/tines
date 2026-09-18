import { describe, expect, it } from 'vitest';
import { inputToken, withLibraryDocumentDigest } from '@tines/shared';
import {
	automatedPackage,
	inheritedPackage
} from '../../../../../../packages/shared/src/library/fixtures';
import { deriveOwnedPublicationDraft, PublicationDraftError } from './draft';

async function baseline() {
	return withLibraryDocumentDigest(inheritedPackage());
}

async function automatedBaseline() {
	return withLibraryDocumentDigest(automatedPackage());
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

	it.each([
		[
			'workflow description',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				(draft.workflows[0].description += ' Edited workflow description'),
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) => draft.workflows[0].description
		],
		[
			'prompt description',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				(draft.context[0].description = 'Edited prompt description'),
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) => draft.context[0].description
		],
		[
			'prompt body',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) => {
				if (draft.context[0].kind !== 'prompt') throw new Error('fixture changed');
				draft.context[0].body += ' Edited prompt body';
			},
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				draft.context[0].kind === 'prompt' ? draft.context[0].body : null
		],
		[
			'skill description',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				(draft.context[1].description = 'Edited skill description'),
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) => draft.context[1].description
		],
		[
			'skill file content',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) => {
				if (draft.context[1].kind !== 'skill') throw new Error('fixture changed');
				draft.context[1].files[0].content = 'Edited skill content';
			},
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				draft.context[1].kind === 'skill' ? draft.context[1].files[0].content : null
		],
		[
			'repository description',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				(draft.context[2].description = 'Edited repository description'),
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) => draft.context[2].description
		],
		[
			'schedule title template',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				(draft.schedules[0].title_template = 'Edited title {{date}}'),
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) => draft.schedules[0].title_template
		],
		[
			'schedule description template',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				(draft.schedules[0].description_template = 'Edited schedule description'),
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				draft.schedules[0].description_template
		]
	])('admits the editable %s surface', async (_name, mutate, read) => {
		const clean = await automatedBaseline();
		const submitted = structuredClone(clean);
		mutate(submitted);
		const result = await deriveOwnedPublicationDraft(
			clean,
			await withLibraryDocumentDigest(submitted),
			2000
		);
		expect(read(result)).toBe(read(submitted));
		expect(result.exported_at).toBe(2000);
	});

	it.each([
		[
			'workflow name',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				(draft.workflows[0].name = 'Changed')
		],
		[
			'state category',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				(draft.workflows[0].states[0].category = 'done')
		],
		[
			'transition gate',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				(draft.workflows[0].transitions[0].requires[0].description = 'Changed')
		],
		[
			'context name',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) => (draft.context[0].name = 'changed')
		],
		[
			'skill path',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) => {
				if (draft.context[1].kind !== 'skill') throw new Error('fixture changed');
				draft.context[1].files[0].path = 'OTHER.md';
			}
		],
		[
			'repository URL',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) => {
				if (draft.context[2].kind !== 'repo') throw new Error('fixture changed');
				draft.context[2].repo_url = 'https://example.test/changed';
			}
		],
		[
			'schedule recurrence',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				(draft.schedules[0].recurrence = { kind: 'cron', cron: '0 10 * * *' })
		],
		[
			'routing tier',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) => (draft.routing[0].tier = 'smartest')
		],
		[
			'context membership',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) => draft.context.pop()
		],
		[
			'schedule order',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) =>
				draft.schedules.push(structuredClone(draft.schedules[0]))
		],
		[
			'unknown field',
			(draft: Awaited<ReturnType<typeof automatedBaseline>>) => {
				(draft.workflows[0] as unknown as Record<string, unknown>).future_field = true;
			}
		]
	])('rejects the protected %s family', async (_name, mutate) => {
		const clean = await automatedBaseline();
		const submitted = structuredClone(clean);
		mutate(submitted);
		await expect(deriveOwnedPublicationDraft(clean, submitted, 2000)).rejects.toBeInstanceOf(
			PublicationDraftError
		);
	});
});
