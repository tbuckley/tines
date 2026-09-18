import { describe, expect, it } from 'vitest';
import { inputToken, withLibraryDocumentDigest, type WorkflowPackageDocument } from '@tines/shared';
import { normalizeInputDraft, updateAuthoredInput, type InputDraft } from './package-input-editor';

const oldToken = inputToken('review_label', 'customer-reveiw');

function document(): WorkflowPackageDocument {
	return {
		format: 'tines.library',
		version: 3,
		profile: 'workflow',
		exported_at: 1,
		digest: 'old',
		main_workflow_id: 'workflow:1',
		workflows: [
			{
				id: 'workflow:1',
				name: 'Main',
				description: `Active ${oldToken} twice ${oldToken}; escaped \\${oldToken}.`,
				initial_state_id: 'state:1',
				states: [{ id: 'state:1', name: 'Open', category: 'active', inherits_from: null }],
				transitions: []
			}
		],
		context: [],
		inputs: [
			{
				id: 'input:author:1',
				key: 'review_label',
				type: 'text',
				label: 'Review label',
				description: 'Literal description',
				required: true,
				default: 'customer-reveiw'
			},
			{
				id: 'input:author:2',
				key: 'project_name',
				type: 'project',
				label: 'Project name',
				description: '',
				required: false,
				default: 'customer-portal'
			}
		],
		text_uses: [
			{
				id: 'use:author:1',
				target: { record_id: 'workflow:1', field: 'description' },
				input_id: 'input:author:1',
				token: oldToken
			}
		],
		schedules: [],
		routing: []
	};
}

function draft(overrides: Partial<InputDraft> = {}): InputDraft {
	return {
		key: 'review_label',
		type: 'text',
		label: 'Review label',
		description: 'Literal description',
		default: 'customer-reveiw',
		required: true,
		...overrides
	};
}

describe('normalizeInputDraft', () => {
	it('shares add-form trimming, fallback, and null-default rules', () => {
		expect(normalizeInputDraft(draft({ key: ' new_key ', label: ' ', default: '' }))).toMatchObject(
			{
				key: 'new_key',
				label: 'new_key',
				default: null
			}
		);
	});

	it('rejects invalid keys', () => {
		expect(() => normalizeInputDraft(draft({ key: 'Not valid' }))).toThrow('lowercase input key');
	});
});

describe('updateAuthoredInput', () => {
	it('updates every editable field in place while preserving identity, order, and unrelated data', () => {
		const original = document();
		const next = updateAuthoredInput(
			original,
			'input:author:1',
			draft({ type: 'label', label: ' Corrected ', description: 'new', required: false })
		);
		expect(next.inputs[0]).toEqual({
			id: 'input:author:1',
			key: 'review_label',
			type: 'label',
			label: 'Corrected',
			description: 'new',
			required: false,
			default: 'customer-reveiw'
		});
		expect(next.inputs[1]).toEqual(original.inputs[1]);
		expect(next.text_uses).toEqual(original.text_uses);
		expect(original).toEqual(document());
	});

	it('atomically rewrites active registered occurrences but not escaped or unregistered text', async () => {
		const original = document();
		original.context.push({
			id: 'prompt:1',
			name: 'Unregistered',
			description: oldToken,
			kind: 'prompt',
			body: oldToken,
			state_id: 'state:1'
		});
		const nextToken = inputToken('review_key', 'customer:review}\\value');
		const next = updateAuthoredInput(
			original,
			'input:author:1',
			draft({ key: 'review_key', default: 'customer:review}\\value' })
		);
		expect(next.workflows[0].description).toBe(
			`Active ${nextToken} twice ${nextToken}; escaped \\${oldToken}.`
		);
		expect(next.context[0].description).toBe(oldToken);
		expect(next.context[0].kind).toBe('prompt');
		if (next.context[0].kind !== 'prompt') throw new Error('Expected prompt fixture');
		expect(next.context[0].body).toBe(oldToken);
		expect(next.text_uses[0]).toMatchObject({ id: 'use:author:1', token: nextToken });
		await expect(withLibraryDocumentDigest(next)).resolves.toMatchObject({
			digest: expect.stringMatching(/^sha256:/)
		});
		expect(original).toEqual({ ...document(), context: original.context });
	});

	it('resolves every allowed registered field kind and produces a valid sealed document', async () => {
		const original = document();
		original.context = [
			{
				id: 'prompt:1',
				name: 'prompt',
				description: `Prompt description ${oldToken}`,
				kind: 'prompt',
				body: `Prompt body ${oldToken}`,
				state_id: 'state:1'
			},
			{
				id: 'skill:1',
				name: 'skill',
				description: `Skill description ${oldToken}`,
				kind: 'skill',
				files: [{ id: 'file:1', path: 'SKILL.md', content: `File ${oldToken}` }],
				state_id: 'state:1'
			},
			{
				id: 'repo:1',
				name: 'repo',
				description: `Repo description ${oldToken}`,
				kind: 'repo',
				repo_url: 'https://github.com/tbuckley/tines',
				repo_branch: 'main',
				repo_dir: null,
				state_id: 'state:1'
			}
		];
		original.schedules = [
			{
				id: 'schedule:1',
				workflow: { kind: 'bundled_workflow', workflow_id: 'workflow:1' },
				project: { kind: 'input_project', input_id: 'input:author:2' },
				name: 'Daily',
				title_template: `Title ${oldToken}`,
				description_template: `Schedule ${oldToken}`,
				recurrence: { kind: 'preset', preset: { kind: 'daily', time: '05:00' } },
				timezone: 'UTC',
				require_all_closed: false,
				start_state: null
			}
		];
		const targets = [
			['prompt:1', 'description'],
			['prompt:1', 'body'],
			['skill:1', 'description'],
			['file:1', 'content'],
			['repo:1', 'description'],
			['schedule:1', 'title_template'],
			['schedule:1', 'description_template']
		] as const;
		original.text_uses.push(
			...targets.map(([record_id, field], index) => ({
				id: `use:author:${index + 2}`,
				target: { record_id, field },
				input_id: 'input:author:1',
				token: oldToken
			}))
		);

		const nextToken = inputToken('review_label', 'fixed');
		const next = updateAuthoredInput(original, 'input:author:1', draft({ default: 'fixed' }));
		expect(
			JSON.stringify(next).match(new RegExp(nextToken.replace(/[{}]/g, '\\$&'), 'g'))
		).toHaveLength(17);
		expect(
			next.text_uses.every((use) => use.input_id !== 'input:author:1' || use.token === nextToken)
		).toBe(true);
		await expect(withLibraryDocumentDigest(next)).resolves.toMatchObject({
			digest: expect.stringMatching(/^sha256:/)
		});
	});

	it('rejects duplicate, generated, unknown, stale, and inactive edits without mutation', () => {
		const generated = document();
		generated.inputs.push({
			id: 'input:destination_project',
			key: 'destination_project',
			type: 'project',
			label: 'Destination project',
			description: 'Generated destination project',
			required: true,
			default: null
		});
		const cases: Array<() => void> = [
			() => updateAuthoredInput(document(), 'input:author:1', draft({ key: 'project_name' })),
			() => updateAuthoredInput(document(), 'input:missing', draft()),
			() => {
				const value = document();
				value.text_uses[0].token = 'stale';
				updateAuthoredInput(value, 'input:author:1', draft({ default: 'fixed' }));
			},
			() => {
				const value = document();
				value.workflows[0].description = `\\${oldToken}`;
				updateAuthoredInput(value, 'input:author:1', draft({ default: 'fixed' }));
			}
		];
		for (const run of cases) expect(run).toThrow();
		expect(() => updateAuthoredInput(generated, 'input:destination_project', draft())).toThrow(
			'Generated input declarations are read-only.'
		);
	});

	it('preserves required_states and rejects an incompatible type change', () => {
		const original = document();
		original.inputs[0] = { ...original.inputs[0], type: 'workflow', required_states: ['Open'] };
		expect(() => updateAuthoredInput(original, 'input:author:1', draft({ type: 'text' }))).toThrow(
			'required workflow states'
		);
		const next = updateAuthoredInput(
			original,
			'input:author:1',
			draft({ type: 'workflow', label: 'New' })
		);
		expect(next.inputs[0].required_states).toEqual(['Open']);
	});
});
