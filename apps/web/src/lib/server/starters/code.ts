import type { Starter } from './types';

/**
 * "Code repository" — structurally complete, deliberately minimal prose.
 * Tines/250 replaces the stage instructions, the conventions template and
 * the first issue's description with the real content; the shape below is
 * what the apply path and its tests pin.
 */
export const code: Starter = {
	id: 'code',
	name: 'Code repository',
	description: 'Point an agent at a repository: it picks up work, opens pull requests, you review.',
	inputs: [
		{
			key: 'repo_url',
			label: 'Repository URL',
			required: true,
			description: 'Any git URL the runner can clone, e.g. https://github.com/you/app.git',
			max: 1000
		},
		{
			key: 'repo_branch',
			label: 'Branch',
			required: false,
			description: 'Defaults to the repository’s own default branch.',
			max: 200
		}
	],
	workflows: [
		{
			name: 'Code change',
			description: 'Backlog to pull request, with a human review gate.',
			initial_state: 'Backlog',
			states: [
				{ name: 'Backlog', category: 'backlog' },
				{
					name: 'In progress',
					category: 'active',
					prompt:
						'Implement the change the issue describes. Work on a branch, keep commits small, run the project’s tests, then open a pull request that references this issue and attach it as the `pr` artifact.'
				},
				{
					name: 'Review',
					category: 'awaiting_human',
					prompt:
						'A human reviews the pull request. Approve to close the issue, or send it back with the changes you want.'
				},
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				{ name: 'Start', from: 'Backlog', to: 'In progress' },
				{
					name: 'Submit for review',
					from: 'In progress',
					to: 'Review',
					requires: [{ artifact: 'pr', type: 'pr', description: 'The pull request implementing this issue' }]
				},
				{ name: 'Send back', from: 'Review', to: 'In progress' },
				{ name: 'Approve', from: 'Review', to: 'Done' },
				{ name: 'Abandon', from: 'In progress', to: 'Done' }
			]
		}
	],
	default_workflow: 'Code change',
	context: [
		{
			kind: 'repo',
			name: '{{ repo_name }}',
			description: 'Cloned into the run workspace for every issue in this project.',
			repo_url: '{{ repo_url }}',
			repo_branch: '{{ repo_branch }}'
		}
	],
	conventions_template: [
		'Test command: <how to run the tests>',
		'Lint / typecheck command: <how to run them>',
		'Branch naming: <the convention, if you have one>',
		'Anything an agent should never touch: <paths or systems>'
	].join('\n'),
	first_issue: {
		title: 'Find and fix a bug',
		description:
			'Read enough of {{ repo_name }} to find one real, small bug — a wrong edge case, a missing guard, a stale comment that hides a defect — and fix it. Add a test that fails before the fix and passes after.',
		workflow: 'Code change',
		state: 'In progress'
	}
};
