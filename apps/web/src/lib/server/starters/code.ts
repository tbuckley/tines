import type { Starter } from './types';

/** "Code repository" — a complete first pull-request loop. */
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
					prompt: [
						'Read the project conventions before you begin. Unanswered template lines mean “not specified”: find out from the repository or ask instead of guessing.',
						'',
						'Work on a branch that follows the Branch rules in the conventions. Implement the issue, add or update a test, and run the Test command from the conventions. Open a pull request that references this issue and follows the PR expectations.',
						'',
						'Attach the pull request with `tines issues artifacts attach <ref> pr --pr <url>`. Comment on the issue with what you changed, why, and how you verified it, then transition the issue with `tines issues move <ref> "Submit for review"`.'
					].join('\n')
				},
				{
					name: 'Review',
					category: 'awaiting_human',
					prompt: [
						'Review the attached pull request. Check that the chosen change is a real bug, the fix is focused, the test demonstrates the failure and the project’s conventions were followed. If the issue arrived through “No bug found”, review the issue comment and what the agent checked instead.',
						'',
						'Approve when it is ready. If changes are needed, or you know of a small verifiable bug the agent missed, leave a specific comment and choose “Send back”; that returns the issue to In progress so the agent can address the feedback.'
					].join('\n')
				},
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				{ name: 'Start', from: 'Backlog', to: 'In progress' },
				{
					name: 'Submit for review',
					from: 'In progress',
					to: 'Review',
					requires: [
						{ artifact: 'pr', type: 'pr', description: 'The pull request implementing this issue' }
					]
				},
				{ name: 'No bug found', from: 'In progress', to: 'Review' },
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
		'Test command: <the command that must pass before opening a PR>',
		'Branch rules: <the base branch and any branch naming rules>',
		'PR expectations: <what every pull request should include>',
		'Where things live: <the important directories, docs, or files>'
	].join('\n'),
	first_issue: {
		title: 'Find and fix a bug',
		description: [
			'Read {{ repo_name }} and pick one small bug you can verify: a failing test, a crash, a wrong message, or a broken link.',
			'',
			'Fix it on a branch with a test, open a pull request, attach it as the `pr` artifact, and explain in an issue comment why you chose that bug. If nothing qualifies, do not invent work: explain what you checked in a comment, then move this issue to Review with `tines issues move <ref> "No bug found"`.'
		].join('\n'),
		workflow: 'Code change',
		state: 'In progress'
	}
};
