import { describe, expect, it } from 'vitest';
import { inheritedPackage, automatedPackage } from './fixtures.js';
import { validatePackageChoices } from './choices.js';

describe('workflow package choice trust boundary', () => {
	it('accepts exactly typed document-local choices', () => {
		const d = automatedPackage();
		const choices = {
			workflow_names: { 'workflow:1': 'My Review' },
			inputs: {
				'input:1': { mode: 'create', name: 'qa', color: 'blue' },
				'input:2': { mode: 'reuse', id: 'project' }
			},
			schedule_ids: ['schedule:1'],
			routing: { 'routing:1': 'smartest' }
		};
		expect(validatePackageChoices(choices, d)).toEqual(choices);
	});
	for (const choice of [
		null,
		[],
		{ overwrite: true },
		{ workflow_names: { missing: 'Name' } },
		{ workflow_names: { 'workflow:1': '' } },
		{ workflow_names: { 'workflow:1': 'x'.repeat(201) } },
		{ workflow_names: { 'workflow:1': '\uD800' } },
		{ inputs: { 'input:1': { value: 'qa' } } },
		{ inputs: { 'input:1': { mode: 'reuse', id: 'x', extra: true } } },
		{ inputs: { 'input:1': { mode: 'create', name: 'qa', color: 'unknown' } } },
		{ schedule_ids: ['missing'] },
		{ routing: { missing: 'balanced' } }
	]) {
		it(`rejects invalid choices ${JSON.stringify(choice)}`, () =>
			expect(() => validatePackageChoices(choice, inheritedPackage())).toThrow());
	}
	it('refuses create for project/workflow inputs and duplicate schedule choices', () => {
		const d = automatedPackage();
		expect(() =>
			validatePackageChoices(
				{ inputs: { 'input:2': { mode: 'create', name: 'New', color: 'blue' } } },
				d
			)
		).toThrow();
		expect(() =>
			validatePackageChoices({ schedule_ids: ['schedule:1', 'schedule:1'] }, d)
		).toThrow();
	});
	it('retains explicit empty optional text and rejects missing value', () => {
		const d = inheritedPackage();
		d.inputs[0].type = 'text';
		expect(validatePackageChoices({ inputs: { 'input:1': { value: '' } } }, d).inputs).toEqual({
			'input:1': { value: '' }
		});
		expect(() => validatePackageChoices({ inputs: { 'input:1': {} } }, d)).toThrow();
	});
});
