import { describe, expect, it } from 'vitest';
import { describeWorkflowInput, renderPlaceholders, scanPlaceholders } from './placeholders.js';

const values: Record<string, string> = { x: 'X', staging_url: 'https://s', a_1: 'A' };
const render = (text: string) => renderPlaceholders(text, (n) => values[n]);

describe('scanPlaceholders', () => {
	it('finds unique names in first-seen order, with or without spaces', () => {
		expect(
			scanPlaceholders('{{ inputs.x }} {{inputs.staging_url}} {{  inputs.x\t}} {{ inputs.a_1}}')
		).toEqual(['x', 'staging_url', 'a_1']);
	});

	it('skips escaped placeholders and anything outside the strict grammar', () => {
		expect(
			scanPlaceholders(
				'{{! inputs.x }} {{!! inputs.y }} {{ date }} {{ inputs }} {{ inputs.Foo }} {{ inputs.a-b }} {{ inputs.x.y }} {{ input.x }} {{\ninputs.x }}'
			)
		).toEqual([]);
	});
});

describe('renderPlaceholders', () => {
	it('substitutes values', () => {
		expect(render('Test {{ inputs.staging_url }}/api and {{inputs.x}}')).toEqual({
			text: 'Test https://s/api and X',
			missing: []
		});
	});

	it('removes one ! from an escaped placeholder (spec examples)', () => {
		expect(render('{{! inputs.x }}').text).toBe('{{ inputs.x }}');
		expect(render('{{!! inputs.x }}').text).toBe('{{! inputs.x }}');
		expect(render('{{!!! inputs.x }}').text).toBe('{{!! inputs.x }}');
		expect(render('{{!inputs.x}}').text).toBe('{{inputs.x}}');
	});

	it('leaves other double-brace text alone', () => {
		const text = 'Triage for {{ date }}; {{ inputs }}; {{ inputs.Foo }}; {{ count }}';
		expect(render(text)).toEqual({ text, missing: [] });
	});

	it('keeps and reports missing values', () => {
		expect(render('a {{ inputs.nope }} b {{inputs.nope}} {{ inputs.other }}')).toEqual({
			text: 'a {{ inputs.nope }} b {{inputs.nope}} {{ inputs.other }}',
			missing: ['nope', 'other']
		});
	});

	it('does not re-render substituted values', () => {
		expect(renderPlaceholders('{{ inputs.x }}', () => '{{ inputs.x }}').text).toBe(
			'{{ inputs.x }}'
		);
	});
});

describe('describeWorkflowInput', () => {
	it('renders the spec line', () => {
		expect(
			describeWorkflowInput({
				workflowName: 'Engineering',
				stateName: 'Triage',
				workflowId: 'wf_123',
				projectName: 'acme'
			})
		).toBe(
			'the "Engineering" workflow, starting in "Triage" — file with `tines issues create acme -w wf_123 -s Triage -t "<title>"`'
		);
	});

	it('shell-quotes names with spaces or quotes', () => {
		expect(
			describeWorkflowInput({
				workflowName: 'Bugs',
				stateName: 'In review',
				workflowId: 'wf_1',
				projectName: "Tom's project"
			})
		).toBe(
			`the "Bugs" workflow, starting in "In review" — file with \`tines issues create 'Tom'\\''s project' -w wf_1 -s 'In review' -t "<title>"\``
		);
	});
});
