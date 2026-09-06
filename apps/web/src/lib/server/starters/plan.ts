import type { Starter } from './types';

/**
 * "Plan something together" — structurally complete, deliberately minimal
 * prose (the tranche-2 content issue replaces it). Two workflows on purpose:
 * they exercise the per-workflow collision rule, a first issue in a
 * *non-default* workflow, and a non-initial starting state.
 */
export const plan: Starter = {
	id: 'plan',
	name: 'Plan something together',
	description: 'Turn a rough brief into scouted, argued-through proposals you decide on.',
	inputs: [
		{
			key: 'brief',
			label: 'What are you planning?',
			required: true,
			description: 'A sentence is enough — "a hiring plan for Q1", "our move to Postgres".',
			max: 10_000
		}
	],
	workflows: [
		{
			name: 'Idea',
			description: 'An idea, argued through to a decision.',
			initial_state: 'New',
			states: [
				{ name: 'New', category: 'backlog' },
				{
					name: 'Proposed',
					category: 'awaiting_human',
					prompt: 'A proposal is on the table. Read it, then approve it, pass, or send it back.'
				},
				{
					name: 'Reworking',
					category: 'active',
					prompt:
						'Address the feedback on the proposal and re-attach it. Say what changed and what you deliberately did not change.'
				},
				{ name: 'Approved', category: 'done' },
				{ name: 'Passed', category: 'done' }
			],
			transitions: [
				{
					name: 'Propose',
					from: 'New',
					to: 'Proposed',
					requires: [
						{
							artifact: 'proposal',
							type: 'text',
							content_type: 'text/markdown',
							description: 'The proposal: what to do, why, and what it costs'
						}
					]
				},
				{ name: 'Approve', from: 'Proposed', to: 'Approved' },
				{ name: 'Pass', from: 'Proposed', to: 'Passed' },
				{ name: 'Send back', from: 'Proposed', to: 'Reworking' },
				{
					name: 'Re-propose',
					from: 'Reworking',
					to: 'Proposed',
					requires: [
						{
							artifact: 'proposal',
							type: 'text',
							content_type: 'text/markdown',
							description: 'The revised proposal'
						}
					]
				}
			]
		},
		{
			name: 'Scout',
			description: 'Go and look, then file what is worth doing.',
			initial_state: 'Backlog',
			states: [
				{ name: 'Backlog', category: 'backlog' },
				{
					name: 'Scouting',
					category: 'active',
					prompt:
						'Go and look. File each candidate worth pursuing as its own issue in the Idea workflow, with enough detail that someone else could argue about it. Comment what you looked at, including the dead ends.'
				},
				{ name: 'Filed', category: 'done' },
				{ name: 'Nothing found', category: 'done' },
				{ name: 'Abandoned', category: 'done' }
			],
			transitions: [
				{ name: 'Start scouting', from: 'Backlog', to: 'Scouting' },
				{ name: 'File candidates', from: 'Scouting', to: 'Filed' },
				{ name: 'Nothing to file', from: 'Scouting', to: 'Nothing found' },
				{ name: 'Abandon', from: 'Scouting', to: 'Abandoned' }
			]
		}
	],
	default_workflow: 'Idea',
	context: [],
	conventions_template: [
		'What we are planning: {{ brief }}',
		'Who decides: <name or role>',
		'What a good proposal answers: <the questions you always ask>',
		'Constraints that are not negotiable: <budget, deadline, people>'
	].join('\n'),
	first_issue: {
		title: 'Scout candidates for {{ brief }}',
		description:
			'Look into "{{ brief }}" and file the candidates worth arguing about as Idea issues. Breadth first: it is better to file five thin candidates than one thick one.',
		workflow: 'Scout',
		state: 'Scouting'
	}
};
