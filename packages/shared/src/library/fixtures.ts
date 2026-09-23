/** Executable authoring examples: no digest until the shared validator seals them. */
import type { WorkflowPackageDocument, LibraryV3Document } from './types.js';
export function inheritedPackage(): WorkflowPackageDocument {
	return {
		format: 'tines.library',
		version: 3,
		profile: 'workflow',
		exported_at: 1789063200000,
		digest: '',
		main_workflow_id: 'workflow:1',
		workflows: [
			{
				id: 'workflow:1',
				name: 'Reviewer',
				description: 'Review {{filing_label:qa}} work',
				initial_state_id: 'state:1',
				states: [
					{
						id: 'state:1',
						name: 'Review',
						category: 'active',
						inherits_from: { kind: 'bundled_state', state_id: 'state:3' }
					},
					{ id: 'state:2', name: 'Handoff', category: 'done', inherits_from: null }
				],
				transitions: [
					{
						id: 'transition:1',
						name: 'Submit evidence',
						from_state_id: 'state:1',
						to_state_id: 'state:2',
						requires: [
							{
								artifact: 'evidence',
								type: 'text',
								content_type: 'text/markdown',
								description: 'Review evidence'
							}
						]
					}
				]
			},
			{
				id: 'workflow:2',
				name: 'Shared',
				description: 'Shared review instructions',
				initial_state_id: 'state:3',
				states: [{ id: 'state:3', name: 'Base', category: 'active', inherits_from: null }],
				transitions: []
			}
		],
		context: [
			{
				id: 'context:1',
				state_id: 'state:3',
				kind: 'prompt',
				name: 'instructions',
				description: '',
				body: 'File work with label {{filing_label:qa}}. Preserve {{date}}.'
			},
			{
				id: 'context:2',
				state_id: 'state:3',
				kind: 'skill',
				name: 'review',
				description: 'Review guide',
				files: [
					{ id: 'file:1', path: 'SKILL.md', content: 'Review the change and write evidence.' }
				]
			},
			{
				id: 'context:3',
				state_id: 'state:1',
				kind: 'repo',
				name: 'code',
				description: '',
				repo_url: 'https://github.com/example/code',
				repo_branch: 'main',
				repo_dir: 'code'
			}
		],
		inputs: [
			{
				id: 'input:1',
				key: 'filing_label',
				type: 'label',
				label: 'Filing label',
				description: 'Label used in instructions',
				required: true,
				default: 'qa'
			}
		],
		text_uses: [
			{
				id: 'use:1',
				target: { record_id: 'workflow:1', field: 'description' },
				input_id: 'input:1',
				token: '{{filing_label:qa}}'
			},
			{
				id: 'use:2',
				target: { record_id: 'context:1', field: 'body' },
				input_id: 'input:1',
				token: '{{filing_label:qa}}'
			}
		],
		schedules: [],
		routing: []
	};
}

/** Current mutation fixture: one chosen workflow with exact, pointer-free context. */
export function pointerFreePackage(): WorkflowPackageDocument {
	const document = inheritedPackage();
	const workflow = structuredClone(document.workflows[0]);
	workflow.states = workflow.states.map((state) => ({ ...state, inherits_from: null }));
	return {
		...document,
		workflows: [workflow],
		context: document.context.map((item) => ({ ...item, state_id: 'state:1' })),
		text_uses: document.text_uses.filter((use) => use.target.record_id === 'workflow:1')
	};
}

export function automatedPackage(): WorkflowPackageDocument {
	const d = inheritedPackage();
	d.inputs.push({
		id: 'input:2',
		key: 'project',
		type: 'project',
		label: 'Destination project',
		description: '',
		required: true,
		default: null
	});
	d.schedules.push({
		id: 'schedule:1',
		workflow: { kind: 'bundled_workflow', workflow_id: 'workflow:1' },
		project: { kind: 'input_project', input_id: 'input:2' },
		name: 'Weekly review',
		title_template: 'Review {{date}}',
		description_template: 'Review queued work.',
		recurrence: { kind: 'preset', preset: { kind: 'weekly', time: '09:00', weekday: 1 } },
		timezone: 'America/New_York',
		require_all_closed: true,
		start_state: null
	});
	d.routing.push({
		id: 'routing:1',
		scope: { state_id: 'state:1', project: { kind: 'input_project', input_id: 'input:2' } },
		tier: 'balanced'
	});
	return d;
}

export function pointerFreeAutomatedPackage(): WorkflowPackageDocument {
	const d = pointerFreePackage();
	d.inputs.push({
		id: 'input:2',
		key: 'project',
		type: 'project',
		label: 'Destination project',
		description: '',
		required: true,
		default: null
	});
	d.schedules.push({
		id: 'schedule:1',
		workflow: { kind: 'bundled_workflow', workflow_id: 'workflow:1' },
		project: { kind: 'input_project', input_id: 'input:2' },
		name: 'Weekly review',
		title_template: 'Review {{date}}',
		description_template: 'Review queued work.',
		recurrence: { kind: 'preset', preset: { kind: 'weekly', time: '09:00', weekday: 1 } },
		timezone: 'America/New_York',
		require_all_closed: true,
		start_state: null
	});
	d.routing.push({
		id: 'routing:1',
		scope: { state_id: 'state:1', project: { kind: 'input_project', input_id: 'input:2' } },
		tier: 'balanced'
	});
	return d;
}
export function duplicateLibrary(): LibraryV3Document {
	return {
		format: 'tines.library',
		version: 3,
		profile: 'library',
		exported_at: 1789063200000,
		digest: '',
		workflows: [1, 2].map((i) => ({
			id: `workflow:${i}`,
			name: 'Review',
			description: '',
			initial_state_id: `state:${i}`,
			states: [{ id: `state:${i}`, name: 'Ready', category: 'active', inherits_from: null }],
			transitions: []
		})),
		projects: [
			{
				id: 'project:1',
				name: 'Destination',
				description: '',
				default_workflow: { kind: 'bundled_workflow', workflow_id: 'workflow:2' }
			}
		],
		labels: [{ id: 'label:1', name: 'qa', color: 'blue' }],
		context: [
			{
				id: 'context:1',
				kind: 'prompt',
				name: 'instructions',
				description: '',
				body: 'First review',
				scope: { state: { kind: 'bundled_state', state_id: 'state:1' } },
				journal: false
			},
			{
				id: 'context:2',
				kind: 'prompt',
				name: 'instructions',
				description: '',
				body: 'Second review',
				scope: { state: { kind: 'bundled_state', state_id: 'state:2' } },
				journal: false
			},
			{
				id: 'context:3',
				kind: 'prompt',
				name: 'journal',
				description: '',
				body: 'Shared lesson',
				scope: {
					project_id: 'project:1',
					state: { kind: 'system_state', workflow: 'Standard', state_name: 'Open' },
					label_id: 'label:1'
				},
				journal: true
			},
			{
				id: 'context:4',
				kind: 'prompt',
				name: 'general',
				description: '',
				body: 'Global instructions',
				scope: {},
				journal: false
			}
		]
	};
}
