import { describe, expect, it } from 'vitest';
import { inheritedPackage } from '../../../../../packages/shared/src/library/fixtures';
import { inspectorTargetId, publicInstructionLayers } from './inspector';

describe('public snapshot inspector', () => {
	it('uses distinct exact IDs without CSS selector interpolation', () => {
		expect(inspectorTargetId({ kind: 'field', recordId: 'file:a/b', field: 'content' })).toBe(
			'public-field-8-file:a/b-7-content'
		);
		expect(inspectorTargetId({ kind: 'input', inputId: 'file:a/b' })).not.toBe(
			inspectorTargetId({ kind: 'field', recordId: 'file:a/b', field: 'content' })
		);
	});

	it('keeps empty inheritance layers and document order from root to local', () => {
		const document = inheritedPackage();
		const layers = publicInstructionLayers(document, 'state:1');
		expect(layers.map((layer) => [layer.workflowName, layer.stateName, layer.local])).toEqual([
			['Shared', 'Base', false],
			['Reviewer', 'Review', true]
		]);
		expect(layers[0].items.map(({ item }) => item.id)).toEqual(['context:1', 'context:2']);
		expect(layers[1].items.map(({ item }) => item.id)).toEqual(['context:3']);
	});

	it('labels overridden skill and repo declarations but keeps prompts additive', () => {
		const document = inheritedPackage();
		const inheritedSkill = document.context.find((item) => item.kind === 'skill')!;
		document.context.push({
			...inheritedSkill,
			id: 'context:local-skill',
			state_id: 'state:1',
			files: []
		});
		const layers = publicInstructionLayers(document, 'state:1');
		expect(layers[0].items.find(({ item }) => item.id === 'context:2')?.overriddenBy).toBe(
			'context:local-skill'
		);
		expect(layers[0].items.find(({ item }) => item.id === 'context:1')?.overriddenBy).toBeNull();
	});
});
