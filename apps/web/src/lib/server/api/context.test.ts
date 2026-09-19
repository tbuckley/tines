import { repoDirFromUrl, type EffectiveContext, type IssueDetail } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { getDb } from '$lib/server/db';
import { OPEN, PROJECT, USER, addIssue, seedBase } from '../supervisor/test-fixtures';
import type { ActorContext } from './core';
import {
	buildLaunchPrompt,
	buildResumePrompt,
	contextSummaryForIssue,
	countSharedContextItems,
	createContextItem,
	deleteContextItem,
	effectiveContextForIssue,
	envDigest,
	getContextItem,
	resolvedEnvForIssue,
	updateContextItem,
	isJournal,
	issueBlock,
	layerRank,
	listContextItems,
	loadFiles,
	selectLaunchComments,
	stitchPrompt,
	validateWorkspacePath
} from './context';
import { ApiFail } from './core';
import { createTestDb, type TestDb } from './test-db';

describe('layerRank', () => {
	it('orders the sixteen scopes exactly as the spec enumerates them', () => {
		const scopes = [
			{}, // 0. global (empty scope)
			{ projectId: 'p' }, // 1. project
			{ workflowStateId: 's' }, // 2. state
			{ projectId: 'p', workflowStateId: 's' }, // 3. project ∧ state
			{ labelId: 'l' }, // 4. label
			{ labelId: 'l', projectId: 'p' }, // 5. label ∧ project
			{ labelId: 'l', workflowStateId: 's' }, // 6. label ∧ state
			{ labelId: 'l', projectId: 'p', workflowStateId: 's' }, // 7. label ∧ project ∧ state
			{ issueId: 'i' }, // 8. issue
			{ issueId: 'i', projectId: 'p' }, // 9. issue ∧ project
			{ issueId: 'i', workflowStateId: 's' }, // 10. issue ∧ state
			{ issueId: 'i', projectId: 'p', workflowStateId: 's' }, // 11. issue ∧ project ∧ state
			{ issueId: 'i', labelId: 'l' }, // 12. issue ∧ label
			{ issueId: 'i', labelId: 'l', projectId: 'p' }, // 13. issue ∧ label ∧ project
			{ issueId: 'i', labelId: 'l', workflowStateId: 's' }, // 14. issue ∧ label ∧ state
			{ issueId: 'i', labelId: 'l', projectId: 'p', workflowStateId: 's' } // 15. all four
		];
		expect(scopes.map(layerRank)).toEqual([...Array(16).keys()]);
	});

	it('puts any issue-anchored scope after any non-issue-anchored one', () => {
		expect(layerRank({ issueId: 'i' })).toBeGreaterThan(
			layerRank({ labelId: 'l', projectId: 'p', workflowStateId: 's' })
		);
	});

	// The label bit is a *prefix extension*: adding it must not re-rank any
	// layer that shipped before it, or every existing override flips.
	it('leaves the seven pre-label layers in their original relative order', () => {
		const shipped = [
			{},
			{ projectId: 'p' },
			{ workflowStateId: 's' },
			{ projectId: 'p', workflowStateId: 's' },
			{ issueId: 'i' },
			{ issueId: 'i', projectId: 'p' },
			{ issueId: 'i', workflowStateId: 's' },
			{ issueId: 'i', projectId: 'p', workflowStateId: 's' }
		];
		expect(shipped.map(layerRank)).toEqual([0, 1, 2, 3, 8, 9, 10, 11]);
	});

	it('ranks a label layer above every ambient layer and below every issue layer', () => {
		expect(layerRank({ labelId: 'l' })).toBeGreaterThan(
			layerRank({ projectId: 'p', workflowStateId: 's' })
		);
		expect(layerRank({ labelId: 'l', projectId: 'p', workflowStateId: 's' })).toBeLessThan(
			layerRank({ issueId: 'i' })
		);
	});
});

describe('isJournal', () => {
	const base = {
		kind: 'prompt',
		name: 'journal',
		project_id: 'p',
		workflow_state_id: 's',
		issue_id: null
	};
	it('matches only a prompt named journal at exactly project ∧ state', () => {
		expect(isJournal(base)).toBe(true);
		expect(isJournal({ ...base, kind: 'skill' })).toBe(false);
		expect(isJournal({ ...base, name: 'notes' })).toBe(false);
		expect(isJournal({ ...base, project_id: null })).toBe(false);
		expect(isJournal({ ...base, workflow_state_id: null })).toBe(false);
		expect(isJournal({ ...base, issue_id: 'i' })).toBe(false);
	});
});

describe('stitchPrompt', () => {
	it('puts each trimmed body under its heading, blank-line separated', () => {
		const text = stitchPrompt([
			{ label: 'project Tines', body: '\nHouse rules.\n\n' },
			{ label: 'project Tines · state Implementing', body: 'Journal note.' }
		]);
		expect(text).toBe(
			'## Context: project Tines\n\nHouse rules.\n\n## Context: project Tines · state Implementing\n\nJournal note.'
		);
	});

	it('keeps the heading even for an empty body and returns "" for no parts', () => {
		expect(stitchPrompt([])).toBe('');
		expect(stitchPrompt([{ label: 'project X', body: '  ' }])).toBe('## Context: project X');
	});

	it('renders the journal part under "## Journal (<scope label>)"', () => {
		const text = stitchPrompt([
			{ label: 'project Tines', body: 'House.' },
			{ label: 'project Tines · state Implementing', body: '- lesson', isJournal: true }
		]);
		expect(text).toContain('## Journal (project Tines · state Implementing)\n\n- lesson');
		expect(text).toContain('## Context: project Tines\n\nHouse.');
	});
});

describe('validateWorkspacePath', () => {
	it('accepts nested relative paths', () => {
		expect(validateWorkspacePath('SKILL.md', 'p')).toBe('SKILL.md');
		expect(validateWorkspacePath('scripts/run.sh', 'p')).toBe('scripts/run.sh');
	});

	it.each([
		['/abs.md', 'leading /'],
		['a/../b.md', '..'],
		['./a.md', '. segment'],
		['a//b.md', 'empty segment'],
		['a/', 'trailing slash'],
		['a=b.md', '='],
		['a\\b.md', 'backslash']
	])('rejects %s (%s)', (path) => {
		expect(() => validateWorkspacePath(path, 'p')).toThrowError(ApiFail);
	});
});

describe('repoDirFromUrl', () => {
	it('takes the URL basename and strips .git', () => {
		expect(repoDirFromUrl('https://github.com/acme/api.git')).toBe('api');
		expect(repoDirFromUrl('https://github.com/acme/web/')).toBe('web');
		expect(repoDirFromUrl('git@github.com:acme/tools.git')).toBe('tools');
	});

	it('falls back to "repo" when the basename would break the workspace path rules', () => {
		// An explicit repo_dir goes through validateWorkspacePath; the derived
		// dir must be held to the same rules or it escapes the workspace.
		expect(repoDirFromUrl('https://example.com/x/..')).toBe('repo');
		expect(repoDirFromUrl('https://example.com/x/.')).toBe('repo');
		expect(repoDirFromUrl('https://example.com/a\\b')).toBe('repo');
		expect(repoDirFromUrl('https://example.com/a=b')).toBe('repo');
		expect(repoDirFromUrl('')).toBe('repo');
	});
});

const issue: IssueDetail = {
	id: 'iss_1',
	project_id: 'prj_1',
	project_name: 'Tines',
	project_archived_at: null,
	number: 42,
	title: 'Ship the thing',
	description: 'Do it *well*.',
	labels: [],
	arrived_via: null,
	workflow_id: 'wf_1',
	state: {
		id: 's_review',
		name: 'Review',
		category: 'awaiting_human',
		position: 1,
		inherits_from: null
	},
	effective_state: {
		id: 's_review',
		name: 'Review',
		category: 'awaiting_human',
		position: 1,
		inherits_from: null
	},
	duplicate_of: null,
	open_blockers: [],
	links: { blocked_by: [], blocks: [], duplicate_of: null, duplicated_by: [] },
	scheduled_task_id: null,
	scheduled_task_name: null,
	scheduled_task_project_id: null,
	scheduled_task_project_name: null,
	pinned_runner_id: null,
	pinned_runner_name: null,
	pinned_tier: null,
	attempt_count: 0,
	needs_attention: false,
	active_run: null,
	created_at: 0,
	updated_at: 0,
	last_activity_at: 0,
	workflow: {
		id: 'wf_1',
		name: 'Two-step',
		description: '',
		is_system: false,
		initial_state_id: 's_open',
		states: [],
		transitions: [],
		issue_count: 1,
		created_at: 0,
		updated_at: 0
	},
	comments: [
		{
			id: 'cmt_1',
			issue_id: 'iss_1',
			body: 'Looks close.',
			actor: { user_id: 'u1', user_name: 'Alice', api_key_id: 'k1', api_key_name: 'laptop' },
			created_at: 1700000000000,
			updated_at: null
		}
	],
	allowed_transitions: [
		{
			transition_id: 't1',
			name: 'send back',
			to_state: { id: 's_open', name: 'Open', category: 'active', position: 0, inherits_from: null }
		}
	],
	state_entered_at: 0,
	context_summary: { prompts: 0, skills: 0, repos: 0, artifacts: 0, envs: 0 }
};

const emptyScope = {
	project_id: null,
	project_name: null,
	workflow_state_id: null,
	workflow_state_name: null,
	label_id: null,
	label_name: null,
	label_color: null,
	workflow_id: null,
	workflow_name: null,
	issue_id: null,
	issue_ref: null,
	label: 'global'
};

/** No journal item anywhere, and the issue's state is its own root. */
const noJournal = { state_id: 's_review', inherited_from: null, item_id: null, version: null };

const emptyContext: EffectiveContext = {
	prompt: { text: '', parts: [], journal: noJournal },
	skills: [],
	repos: [],
	env: [],
	overridden: [],
	conflicts: []
};

const richContext: EffectiveContext = {
	prompt: {
		text: '## Context: global\n\nGuidance.\n\n## Journal (project Tines · state Review)\n\n- lesson',
		journal: { state_id: 's_review', inherited_from: null, item_id: 'ctx_j', version: 7 },
		parts: [
			{
				item_id: 'ctx_g',
				name: 'agent-guidelines',
				scope: emptyScope,
				body: 'Guidance.',
				version: 4,
				is_journal: false,
				inherited_from: null
			},
			{
				item_id: 'ctx_j',
				name: 'journal',
				scope: {
					...emptyScope,
					project_id: 'prj_1',
					project_name: 'Tines',
					workflow_state_id: 's_review',
					workflow_state_name: 'Review',
					label: 'project Tines · state Review'
				},
				body: '- lesson',
				version: 7,
				is_journal: true,
				inherited_from: null
			},
			{
				item_id: 'ctx_c',
				name: 'constraints',
				scope: {
					...emptyScope,
					issue_id: 'iss_1',
					issue_ref: { project_name: 'Tines', number: 42 },
					label: 'issue Tines/42'
				},
				body: 'Must stream.',
				version: 1,
				is_journal: false,
				inherited_from: null
			}
		]
	},
	skills: [
		{
			item_id: 'ctx_s',
			name: 'review-checklist',
			description: 'Check the implementation before review.',
			scope: {
				...emptyScope,
				workflow_state_id: 's_review',
				workflow_state_name: 'Review',
				label: 'state Review'
			},
			files: [{ path: 'SKILL.md', content: 'x' }],
			file_count: 1,
			version: 2,
			inherited_from: null
		}
	],
	repos: [
		{
			item_id: 'ctx_r',
			name: 'src',
			scope: {
				...emptyScope,
				issue_id: 'iss_1',
				issue_ref: { project_name: 'Tines', number: 42 },
				label: 'issue Tines/42'
			},
			url: 'https://github.com/acme/api.git',
			branch: 'experiment',
			dir: 'api',
			version: 1,
			inherited_from: null
		}
	],
	env: [],
	overridden: [],
	conflicts: []
};

describe('issueBlock', () => {
	const runComment = (id: string, created_at: number, body = `body ${id}`, issueNumber = 42) => ({
		...issue.comments[0],
		id,
		body,
		created_at,
		actor: {
			...issue.comments[0].actor,
			run: {
				run_id: `run_${id}`,
				runner_name: 'runner',
				issue_ref: { project_name: 'Tines', number: issueNumber }
			}
		}
	});

	it('keeps humans, a protected handoff, and three other latest agent comments', () => {
		const run = {
			run_id: 'run',
			runner_name: 'runner',
			issue_ref: { project_name: 'Tines', number: 42 }
		};
		const comments = [
			{ ...issue.comments[0], id: 'cmt_h', body: 'human body' },
			...['a', 'b', 'c', 'd', 'e'].map((suffix, index) => ({
				...issue.comments[0],
				id: `cmt_${suffix}`,
				body: `agent body ${suffix}`,
				created_at: 1700000001000 + index,
				actor: { ...issue.comments[0].actor, run: { ...run, run_id: `run_${suffix}` } }
			})),
			{ ...issue.comments[0], id: 'cmt_h', body: 'human body' }
		];
		const launchIssue = {
			...issue,
			comments,
			launch_comments: { latest_completed_run_comment_id: 'cmt_a' }
		};
		const before = structuredClone(launchIssue.comments);
		const selected = selectLaunchComments(launchIssue);
		expect(selected.retained.map((comment) => comment.id)).toEqual([
			'cmt_h',
			'cmt_a',
			'cmt_c',
			'cmt_d',
			'cmt_e'
		]);
		expect(selected.omittedAgentIds).toEqual(['cmt_b']);
		expect(launchIssue.comments).toEqual(before);
		const block = issueBlock(launchIssue, emptyContext);
		expect(block).toContain('Older agent comments: cmt_b. Load one');
		expect(block).not.toContain('agent body b');
		expect(block).toContain('agent body a');
	});

	it('keeps the full thread when launch metadata is absent', () => {
		const run = {
			run_id: 'run',
			runner_name: 'runner',
			issue_ref: { project_name: 'Tines', number: 42 }
		};
		const comments = Array.from({ length: 5 }, (_, index) => ({
			...issue.comments[0],
			id: `cmt_${index}`,
			body: `body ${index}`,
			actor: { ...issue.comments[0].actor, run }
		}));
		expect(selectLaunchComments({ ...issue, comments }).retained).toHaveLength(5);
	});

	it.each([
		[0, []],
		[1, ['cmt_0']],
		[2, ['cmt_0', 'cmt_1']],
		[3, ['cmt_0', 'cmt_1', 'cmt_2']]
	] as const)('keeps all of %i agent comments', (count, ids) => {
		const comments = Array.from({ length: count }, (_, i) => runComment(`cmt_${i}`, 100 + i));
		const selected = selectLaunchComments({
			...issue,
			comments,
			launch_comments: { latest_completed_run_comment_id: null }
		});
		expect(selected.retained.map((comment) => comment.id)).toEqual(ids);
		expect(selected.omittedAgentIds).toEqual([]);
	});

	it('uses stable timestamp/id order, keeps unknown provenance as human, and protects an older handoff', () => {
		const unknown = {
			...issue.comments[0],
			id: 'cmt_unknown',
			created_at: 5,
			body: 'unknown body'
		};
		const comments = [
			runComment('cmt_z', 10),
			runComment('cmt_a', 10),
			runComment('cmt_handoff', 1, 'required old detail'),
			unknown,
			runComment('cmt_cross_1', 20, 'cross one', 99),
			runComment('cmt_cross_2', 21, 'cross two', 99),
			runComment('cmt_cross_3', 22, 'cross three', 99),
			runComment('cmt_a', 10, 'duplicate must not render')
		];
		const launchIssue = {
			...issue,
			comments,
			launch_comments: { latest_completed_run_comment_id: 'cmt_handoff' }
		};
		const selected = selectLaunchComments(launchIssue);
		expect(selected.retained.map((comment) => comment.id)).toEqual([
			'cmt_handoff',
			'cmt_unknown',
			'cmt_cross_1',
			'cmt_cross_2',
			'cmt_cross_3'
		]);
		expect(selected.omittedAgentIds).toEqual(['cmt_a', 'cmt_z']);
		const block = issueBlock(
			{
				...launchIssue,
				round: { summary_comment: { body: 'OMITTED SENTINEL' } } as unknown as IssueDetail['round']
			},
			emptyContext
		);
		expect(block).toContain('required old detail');
		expect(block).toContain('unknown body');
		expect(block).not.toContain('body cmt_a');
		expect(block).not.toContain('duplicate must not render');
		expect(block).not.toContain('OMITTED SENTINEL');
		expect(block.match(/Older agent comments:/g)).toHaveLength(1);
	});

	it('renders skill descriptions once, collapses whitespace, and falls back for empty text', () => {
		const context = structuredClone(richContext);
		context.skills[0].description = ' Check the\n implementation   before review. ';
		context.skills.push({
			...context.skills[0],
			item_id: 'ctx_empty',
			name: 'empty-skill',
			description: '   ',
			files: [{ path: 'SKILL.md', content: 'EMPTY SKILL BODY' }]
		});
		const block = issueBlock(issue, context);
		expect(block.match(/Check the implementation before review\./g)).toHaveLength(1);
		expect(block).toContain(
			'Skill "empty-skill" (state Review): read `skills/empty-skill/SKILL.md` when the "empty-skill" procedure is relevant.'
		);
		expect(block).toContain('tines issues context Tines/42 --json');
		expect(block).not.toContain('EMPTY SKILL BODY');
	});

	it('renders the factual block with runnable CLI commands', () => {
		const block = issueBlock(issue, emptyContext);
		expect(block).toContain('## Issue: Tines/42 — Ship the thing');
		expect(block).toContain('Do it *well*.');
		expect(block).toContain('Review (awaiting_human), in workflow "Two-step".');
		expect(block).toContain(
			'**Alice via laptop** (2023-11-14T22:13:20.000Z, ID: cmt_1):\nLooks close.'
		);
		// The comment affordance is a quoted heredoc, so an agent's prose survives
		// the shell verbatim (Tines/9) — with the fallback spelled out, because a
		// CLI predating that change posts a bare `-` and exits 0. Asserted as one
		// whole line: split across two lines.push() entries it renders with a
		// newline in the middle and reads as a broken sentence.
		expect(block).toContain("tines issues comment Tines/42 - <<'EOF'");
		expect(block).toContain(
			'A `tines` too old for that form posts a literal `-` instead of your body, without failing. If `tines issues comment --help` does not mention `@file`, use `tines issues comment Tines/42 "<markdown>"` and mind the shell quoting.'
		);
		// Repair affordance (Tines/11), one whole line for the same reason.
		expect(block).toContain(
			'Fix your own mis-post rather than leaving it in the thread: `tines issues comment-edit Tines/42 <comment-id> -` (same body forms) replaces a body, `tines issues comment-delete Tines/42 <comment-id>` removes it. Ids are echoed when you post and listed by `tines issues show Tines/42 --json`; you can only edit or delete comments you wrote.'
		);
		// Multi-word actions are quoted so they paste correctly.
		expect(block).toContain(
			'- **send back** → Open (active): `tines issues move Tines/42 "send back"`'
		);
	});

	it('says so when there are no comments or transitions', () => {
		const block = issueBlock({ ...issue, comments: [], allowed_transitions: [] }, emptyContext);
		expect(block).toContain('No comments yet.');
		expect(block).toContain('None — this state is terminal.');
	});

	it('offers the id-free journal commands, with the create-on-first-append variant', () => {
		const withJournal = issueBlock(issue, richContext);
		expect(withJournal).toContain('### Journal');
		expect(withJournal).toContain('(currently v7)');
		expect(withJournal).toContain('`tines journal append Tines/42 "- <date>: <lesson>"`');
		// ...and the shell-proof alternative for bodies that need it.
		expect(withJournal).toContain('(or `-` with a quoted heredoc, as for comments,');
		expect(withJournal).toContain(
			'`tines journal rewrite Tines/42 --body @file --expect-version 7`'
		);
		// The old append-before-you-move ordering trap, retired by run anchoring.
		expect(withJournal).toContain(
			"Appends land in this stage's journal even after you move the issue."
		);
		expect(withJournal).not.toContain('ctx_'); // no item ids anywhere

		const without = issueBlock(issue, emptyContext);
		expect(without).toContain('No journal exists yet for project Tines · state Review. Start one:');
		expect(without).toContain('(or `-` with a quoted heredoc, as for comments,');
	});

	it('opens with the human steer, before the thread, when there is one', () => {
		const at = 1_699_999_000_000;
		const steered = issueBlock(
			{
				...issue,
				since_last_run: {
					previous_run: {
						run_id: 'arun_1',
						ended_at: at - 3600_000,
						state_at_start_name: 'Implementation'
					},
					transition: {
						action: 'Send back to implementation',
						from_state: { id: 's_review', name: 'Human Review' },
						to_state: { id: 's_impl', name: 'Implementation' },
						actor: {
							user_id: 'u1',
							user_name: 'Tom Buckley',
							api_key_id: null,
							api_key_name: null
						},
						at
					},
					comments: [
						{
							id: 'cmt_h',
							issue_id: 'iss_1',
							body: 'CI is red on the e2e job.',
							actor: {
								user_id: 'u1',
								user_name: 'Tom Buckley',
								api_key_id: null,
								api_key_name: null
							},
							created_at: at - 1000,
							updated_at: null
						}
					],
					comment_count: 1,
					stale_artifacts: ['impl-pr']
				}
			},
			emptyContext,
			[],
			[],
			at + 7_200_000
		);
		expect(steered).toContain('### Since the last run');
		expect(steered).toContain(
			'Moved from **Human Review** → Implementation via "Send back to implementation" by Tom Buckley, 2h ago'
		);
		expect(steered).toContain('Now stale: `impl-pr`.');
		expect(steered).toContain(
			'**Tom Buckley** (2023-11-14T21:56:39.000Z, ID: cmt_h):\nCI is red on the e2e job.'
		);
		// The steer is what this run is for, so it precedes everything the agent
		// would otherwise read first — including the full thread.
		expect(steered.indexOf('### Since the last run')).toBeLessThan(steered.indexOf('### Comments'));
		expect(steered.indexOf('Do it *well*.')).toBeLessThan(
			steered.indexOf('### Since the last run')
		);
	});

	it('pluralises the capped-comment trailer, singular included', () => {
		const at = 1_699_999_000_000;
		const human = { user_id: 'u1', user_name: 'Tom Buckley', api_key_id: null, api_key_name: null };
		const comment = {
			id: 'cmt_h',
			issue_id: 'iss_1',
			body: 'CI is red on the e2e job.',
			actor: human,
			created_at: at - 1000,
			updated_at: null
		};
		const since = {
			previous_run: {
				run_id: 'arun_1',
				ended_at: at - 3600_000,
				state_at_start_name: 'Implementation'
			},
			transition: null,
			comments: Array.from({ length: 10 }, (_, i) => ({ ...comment, id: `cmt_${i}` })),
			stale_artifacts: []
		};
		// The cap is ten, so an eleventh comment hides exactly one — the common
		// shape, and the one the hardcoded plural got wrong in agent-facing text.
		const capped = issueBlock(
			{ ...issue, since_last_run: { ...since, comment_count: 11 } },
			emptyContext
		);
		expect(capped).toContain('… and 1 earlier comment — see ### Comments below.');
		const two = issueBlock(
			{ ...issue, since_last_run: { ...since, comment_count: 12 } },
			emptyContext
		);
		expect(two).toContain('… and 2 earlier comments — see ### Comments below.');
	});

	it('omits the steer section entirely when nothing human happened', () => {
		expect(issueBlock(issue, emptyContext)).not.toContain('### Since the last run');
		expect(issueBlock({ ...issue, since_last_run: null }, emptyContext)).not.toContain(
			'### Since the last run'
		);
	});

	it('lists artifacts with the fetch command and shared prompts names-only', () => {
		const block = issueBlock(issue, richContext);
		expect(block).toContain(
			'Skill "review-checklist" (state Review): read `skills/review-checklist/SKILL.md`'
		);
		expect(block).toContain(
			'Attached to this issue: repo "src" (branch experiment). Fetch them: `tines issues context Tines/42 --out <dir>`'
		);
		// Shared footnote: global + non-journal, non-issue-anchored prompts —
		// the issue-scoped "constraints" prompt is the issue's own, not listed.
		expect(block).toContain('Also in effect: prompt "agent-guidelines" (global)');
		expect(block).not.toContain('"constraints"');
		expect(block).toContain('file an issue titled `Context change: <scope label>`');
	});
});

describe('buildLaunchPrompt', () => {
	it('applies launch selection to both cold and resumed prompts', () => {
		const comments = Array.from({ length: 5 }, (_, i) => ({
			...issue.comments[0],
			id: `cmt_${i}`,
			body: i === 0 ? 'OMITTED COLD RESUME SENTINEL' : `kept ${i}`,
			created_at: i,
			actor: {
				...issue.comments[0].actor,
				run: {
					run_id: `run_${i}`,
					runner_name: 'runner',
					issue_ref: { project_name: 'Tines', number: 42 }
				}
			}
		}));
		const launchIssue = {
			...issue,
			comments,
			launch_comments: { latest_completed_run_comment_id: null }
		};
		for (const text of [
			buildLaunchPrompt(richContext, launchIssue),
			buildResumePrompt(richContext, launchIssue)
		]) {
			expect(text).toContain('Older agent comments: cmt_0, cmt_1.');
			expect(text).not.toContain('OMITTED COLD RESUME SENTINEL');
			expect(text).toContain('Skill "review-checklist"');
		}
	});
	it('puts the context first and the issue block last', () => {
		const text = buildLaunchPrompt(richContext, issue);
		expect(text.startsWith('## Context: global')).toBe(true);
		expect(text.indexOf('## Issue:')).toBeGreaterThan(
			text.indexOf('## Journal (project Tines · state Review)')
		);
	});

	it('is just the issue block when no context applies', () => {
		expect(buildLaunchPrompt(emptyContext, issue).startsWith('## Issue:')).toBe(true);
	});

	it('carries the label set and advertises the label command with the vocabulary', () => {
		const labeled = { ...issue, labels: [{ id: 'lbl_1', name: 'bug', color: 'red' as const }] };
		const text = buildLaunchPrompt(emptyContext, labeled, [], ['bug', 'chore']);
		expect(text).toContain('Labels: bug');
		expect(text).toContain('tines issues label Tines/42 <name...>');
		// Spelled out because a run key can only apply labels that exist.
		expect(text).toContain('existing labels only: bug, chore');
	});

	it('caps the spelled-out vocabulary rather than inlining a whole library', () => {
		const many = Array.from({ length: 45 }, (_, i) => `label-${i}`);
		const text = buildLaunchPrompt(emptyContext, issue, [], many);
		expect(text).toContain('label-39, +5 more (`tines labels list`)');
		expect(text).not.toContain('label-40');
	});

	it('omits the label line when the issue has none, and says so when none exist', () => {
		const text = buildLaunchPrompt(emptyContext, issue, [], []);
		expect(text).not.toContain('Labels:');
		expect(text).toContain('no labels exist yet');
	});
});

describe('buildResumePrompt', () => {
	it('keeps the stage context and the issue block, and drops what the session already holds', () => {
		const text = buildResumePrompt(richContext, issue);
		// The stage's own instructions and journal stay: a send-back usually
		// crosses stages, so the contract the agent is now working under is
		// exactly what its previous prompt did NOT contain.
		expect(text).toContain('## Journal (project Tines · state Review)');
		expect(text.indexOf('## Issue:')).toBeGreaterThan(text.indexOf('## Journal'));
		// Global and project parts are dropped — the continued conversation is
		// still holding them, and repeating them only lengthens every later turn.
		expect(text).not.toContain('## Context: global');
		expect(text).not.toContain('## Context: project Tines');
		// Which makes it strictly shorter than the cold launch prompt.
		expect(text.length).toBeLessThan(buildLaunchPrompt(richContext, issue).length);
	});

	it('is just the issue block when the stage contributes nothing', () => {
		expect(buildResumePrompt(emptyContext, issue).startsWith('## Issue:')).toBe(true);
	});
});

describe('listContextItems workflow filter', () => {
	// Two workflows sharing a state name is the case the Context page's
	// filter exists for: "Review" alone says nothing about which flow it is.
	function seed(): TestDb {
		const t = createTestDb();
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
				VALUES ('u1', 'alice', 'a@example.com', 1, 0, 0);
			INSERT INTO project (id, user_id, name, created_at, updated_at)
				VALUES ('prj_1', 'u1', 'demo', 0, 0);
			INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at) VALUES
				('wf_eng', 'u1', 'Engineering', '', 'wfs_eng_review', 0, 0),
				('wf_qa', 'u1', 'QA', '', 'wfs_qa_review', 0, 0);
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at) VALUES
				('wfs_eng_review', 'wf_eng', 'Review', 'active', 0, 0),
				('wfs_eng_done', 'wf_eng', 'Done', 'done', 1, 0),
				('wfs_qa_review', 'wf_qa', 'Review', 'active', 0, 0);
			INSERT INTO context_item (id, user_id, kind, name, description, project_id, workflow_state_id,
				issue_id, body, position, version, created_at, updated_at) VALUES
				('ctx_eng_review', 'u1', 'prompt', 'instructions', '', NULL, 'wfs_eng_review', NULL, 'e', 0, 1, 0, 3),
				('ctx_eng_done', 'u1', 'skill', 'wrap-up', '', 'prj_1', 'wfs_eng_done', NULL, NULL, 0, 1, 0, 2),
				('ctx_qa_review', 'u1', 'prompt', 'instructions', '', NULL, 'wfs_qa_review', NULL, 'q', 0, 1, 0, 1),
				('ctx_global', 'u1', 'prompt', 'agent-guidelines', '', NULL, NULL, NULL, 'g', 0, 1, 0, 0);
		`);
		return t;
	}
	const page = { cursor: null, limit: 50 };
	const names = (r: { items: { id: string }[] }) => r.items.map((i) => i.id);

	it('keeps only items scoped to a state of that workflow', async () => {
		const t = seed();
		expect(names(await listContextItems(t.db, 'u1', { workflow: 'wf_eng' }, page))).toEqual([
			'ctx_eng_review',
			'ctx_eng_done'
		]);
		expect(names(await listContextItems(t.db, 'u1', { workflow: 'wf_qa' }, page))).toEqual([
			'ctx_qa_review'
		]);
		// Unfiltered still sees everything, newest first.
		expect(names(await listContextItems(t.db, 'u1', {}, page))).toEqual([
			'ctx_eng_review',
			'ctx_eng_done',
			'ctx_qa_review',
			'ctx_global'
		]);
	});

	it('ANDs with the other filters', async () => {
		const t = seed();
		expect(
			names(await listContextItems(t.db, 'u1', { workflow: 'wf_eng', kind: 'prompt' }, page))
		).toEqual(['ctx_eng_review']);
		expect(
			names(await listContextItems(t.db, 'u1', { workflow: 'wf_eng', project: 'demo' }, page))
		).toEqual(['ctx_eng_done']);
		expect(
			names(await listContextItems(t.db, 'u1', { workflow: 'wf_qa', kind: 'skill' }, page))
		).toEqual([]);
	});

	it('never matches an unscoped item, and stays per-user', async () => {
		const t = seed();
		expect(names(await listContextItems(t.db, 'u1', { workflow: 'wf_eng' }, page))).not.toContain(
			'ctx_global'
		);
		expect(names(await listContextItems(t.db, 'u2', { workflow: 'wf_eng' }, page))).toEqual([]);
	});
});

describe('listContextItems search', () => {
	const page = { cursor: null, limit: 50 };

	function seed(): TestDb {
		const t = createTestDb();
		const long = 'a'.repeat(49) + 'needle' + 'b'.repeat(145);
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES
				('u1', 'alice', 'a@example.com', 1, 0, 0),
				('u2', 'bob', 'b@example.com', 1, 0, 0);
			INSERT INTO project (id, user_id, name, created_at, updated_at) VALUES
				('p1', 'u1', 'one', 0, 0), ('p2', 'u1', 'two', 0, 0), ('p3', 'u2', 'private', 0, 0);
		`);
		const insert = t.sqlite.prepare(`INSERT INTO context_item
			(id, user_id, kind, name, description, project_id, workflow_state_id, issue_id, body,
			 position, version, created_at, updated_at) VALUES (?, ?, 'prompt', ?, ?, ?, NULL, NULL, '', 0, 1, 0, ?)`);
		insert.run('by-name', 'u1', `prefix ${'a'.repeat(49)}needle`, '', 'p1', 8);
		insert.run('by-description', 'u1', 'description', long, 'p1', 7);
		insert.run('truncation-decoy', 'u1', `${long.slice(0, 48)}x`, '', 'p1', 6);
		insert.run('literal', 'u1', `literal % _ \\ [x] O'Reilly`, '', 'p1', 5);
		insert.run('other-project', 'u1', `prefix ${'a'.repeat(49)}needle`, '', 'p2', 4);
		insert.run('other-user', 'u2', `prefix ${'a'.repeat(49)}needle`, '', 'p3', 3);
		insert.run('unicode-upper', 'u1', 'Ärger', '', 'p1', 2);
		insert.run('unicode-lower', 'u1', 'ärger', '', 'p1', 1);
		return t;
	}

	it('matches complete long terms across both columns and composes before pagination', async () => {
		const t = seed();
		const q = 'a'.repeat(49) + 'needle';
		const result = await listContextItems(t.db, 'u1', { q, project: 'p1' }, { ...page, limit: 1 });
		expect(result.items.map((item) => item.id)).toEqual(['by-name']);
		expect(result.hasMore).toBe(true);
		expect(
			(await listContextItems(t.db, 'u1', { q, project: 'p1' }, page)).items.map((item) => item.id)
		).toEqual(['by-name', 'by-description']);
	});

	it('treats pattern and SQL characters literally and remains tenant-isolated', async () => {
		const t = seed();
		for (const q of ['%', '_', '\\', '[x]', "O'Reilly"]) {
			expect(
				(await listContextItems(t.db, 'u1', { q }, page)).items.map((item) => item.id),
				q
			).toEqual(['literal']);
		}
		expect(
			(await listContextItems(t.db, 'u2', { q: 'needle' }, page)).items.map((i) => i.id)
		).toEqual(['other-user']);
	});

	it('is ASCII-case-insensitive but does not promise Unicode folding', async () => {
		const t = seed();
		expect((await listContextItems(t.db, 'u1', { q: 'NEEDLE' }, page)).items).toHaveLength(3);
		expect(
			(await listContextItems(t.db, 'u1', { q: 'ÄRGER' }, page)).items.map((i) => i.id)
		).toEqual(['unicode-upper']);
		expect(
			(await listContextItems(t.db, 'u1', { q: 'ärger' }, page)).items.map((i) => i.id)
		).toEqual(['unicode-lower']);
	});
});

describe('focused Context presentation', () => {
	it('includes direct and issue anchors once, and counts only global/state shared items', async () => {
		const t = createTestDb();
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
				VALUES ('u1', 'alice', 'a@example.com', 1, 0, 0);
			INSERT INTO project (id, user_id, name, created_at, updated_at) VALUES
				('p1', 'u1', 'one', 0, 0), ('p2', 'u1', 'two', 0, 0);
			INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, attempt_count, needs_attention, created_at, updated_at, state_entered_at)
				VALUES ('i1', 'p1', 1, 'one', '', 'wf_standard', 'wfs_std_open', 0, 0, 0, 0, 0);
			INSERT INTO context_item (id, user_id, kind, name, description, project_id, workflow_state_id, issue_id, body, position, version, created_at, updated_at) VALUES
				('direct', 'u1', 'prompt', 'direct', '', 'p1', NULL, NULL, '', 0, 1, 0, 4),
				('issue', 'u1', 'prompt', 'issue', '', NULL, NULL, 'i1', '', 0, 1, 0, 3),
				('both', 'u1', 'prompt', 'both', '', 'p1', NULL, 'i1', '', 0, 1, 0, 2),
				('other', 'u1', 'prompt', 'other', '', 'p2', NULL, NULL, '', 0, 1, 0, 1),
				('global', 'u1', 'prompt', 'global', '', NULL, NULL, NULL, '', 0, 1, 0, 0),
				('state', 'u1', 'prompt', 'state', '', NULL, 'wfs_std_open', NULL, '', 0, 1, 0, 0);
		`);
		const result = await listContextItems(
			t.db,
			'u1',
			{ touchesProjectId: 'p1' },
			{ cursor: null, limit: 50 }
		);
		expect(result.items.map((item) => item.id)).toEqual(['direct', 'issue', 'both']);
		expect(await countSharedContextItems(t.db, 'u1')).toBe(2);
	});
});

describe('loadFiles D1 parameter budget', () => {
	it('hydrates three chunks in path order and deduplicates repeated item ids', async () => {
		const t = createTestDb();
		seedBase(t);
		const insertItem = t.sqlite.prepare(
			`INSERT INTO context_item
				(id, user_id, kind, name, description, position, version, created_at, updated_at)
			 VALUES (?, ?, 'skill', ?, '', ?, 1, ?, ?)`
		);
		const insertFile = t.sqlite.prepare(
			`INSERT INTO context_item_file
				(id, context_item_id, path, content, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 0, 0)`
		);
		const ids = Array.from({ length: 181 }, (_, index) => `ctx_bulk_${index}`);
		for (const [index, id] of ids.entries()) {
			insertItem.run(id, USER, `skill-${index}`, index, index, index);
			insertFile.run(`ctf_${index}_z`, id, 'z.txt', `last-${index}`);
			insertFile.run(`ctf_${index}_a`, id, 'a.txt', `first-${index}`);
		}

		const files = await loadFiles(getDb(t.env), [...ids, ids[0], ids[100]]);
		expect([...files.keys()]).toHaveLength(181);
		for (const index of [0, 89, 90, 180]) {
			expect(files.get(ids[index])).toEqual([
				{ path: 'a.txt', content: `first-${index}` },
				{ path: 'z.txt', content: `last-${index}` }
			]);
		}
	});

	it('skips SQL for empty input and omits unknown or fileless items', async () => {
		const t = createTestDb();
		seedBase(t);
		const queries = t.spyOnQueries();
		expect(await loadFiles(getDb(t.env), [])).toEqual(new Map());
		expect(queries()).toEqual([]);

		t.sqlite
			.prepare(
				`INSERT INTO context_item
					(id, user_id, kind, name, description, position, version, created_at, updated_at)
				 VALUES (?, ?, 'skill', ?, '', 0, 1, 0, 0)`
			)
			.run('ctx_fileless', USER, 'fileless');
		expect(await loadFiles(getDb(t.env), ['ctx_fileless', 'ctx_unknown'])).toEqual(new Map());
	});
});

describe('env context items', () => {
	const ENC_KEY = 'test-encryption-key';
	const human: ActorContext = {
		userId: USER,
		userName: 'alice',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};
	const runKey: ActorContext = { ...human, viaSession: false, agentRunId: 'run_1' };
	const fail = async (p: Promise<unknown>) => {
		try {
			await p;
		} catch (e) {
			return e as ApiFail;
		}
		throw new Error('expected a failure');
	};
	function setup(withKey = true) {
		const t = createTestDb();
		seedBase(t);
		if (withKey) t.env.SECRET_ENCRYPTION_KEY = ENC_KEY;
		return { t, db: getDb(t.env) };
	}

	it('validates names: variable pattern and reserved names', async () => {
		const { t, db } = setup();
		for (const name of ['lower', '1ABC', 'A-B']) {
			const e = await fail(
				createContextItem(db, t.env, human, { kind: 'env', name, value: 'x', project_id: PROJECT })
			);
			expect(e).toMatchObject({ status: 422, code: 'invalid_field' });
		}
		for (const name of ['TINES_API_KEY', 'TINES_X', 'PATH']) {
			const e = await fail(
				createContextItem(db, t.env, human, { kind: 'env', name, value: 'x', project_id: PROJECT })
			);
			expect(e).toMatchObject({ status: 422, code: 'reserved_name' });
		}
	});

	it('requires a value, caps it, and rejects foreign fields both ways', async () => {
		const { t, db } = setup();
		expect(
			await fail(
				createContextItem(db, t.env, human, { kind: 'env', name: 'A', project_id: PROJECT })
			)
		).toMatchObject({ status: 422, code: 'invalid_field' });
		expect(
			await fail(
				createContextItem(db, t.env, human, {
					kind: 'env',
					name: 'A',
					value: 'x'.repeat(16 * 1024 + 1),
					project_id: PROJECT
				})
			)
		).toMatchObject({ status: 422, code: 'invalid_field' });
		expect(
			await fail(
				createContextItem(db, t.env, human, {
					kind: 'env',
					name: 'A',
					value: 'x',
					body: 'nope',
					project_id: PROJECT
				})
			)
		).toMatchObject({ status: 422, code: 'kind_payload_mismatch' });
		expect(
			await fail(
				createContextItem(db, t.env, human, {
					kind: 'prompt',
					name: 'p',
					body: 'b',
					value: 'x',
					project_id: PROJECT
				})
			)
		).toMatchObject({ status: 422, code: 'kind_payload_mismatch' });
	});

	it('stores a public value in the clear and a secret encrypted, serializing only the hint', async () => {
		const { t, db } = setup();
		const pub = await createContextItem(db, t.env, human, {
			kind: 'env',
			name: 'NPM_REGISTRY',
			value: 'https://registry.example',
			project_id: PROJECT
		});
		expect(pub).toMatchObject({
			kind: 'env',
			secret: false,
			value_set: true,
			hint: null,
			value: 'https://registry.example'
		});
		const sec = await createContextItem(db, t.env, human, {
			kind: 'env',
			name: 'GH_TOKEN',
			value: 'github_pat_supersecret',
			secret: true,
			hint: 'github_pat_…cret',
			project_id: PROJECT
		});
		expect(sec).toMatchObject({ secret: true, value_set: true, hint: 'github_pat_…cret' });
		expect(JSON.stringify(sec)).not.toContain('supersecret');
		const row = t.sqlite
			.prepare('SELECT env_value, env_value_enc FROM context_item WHERE id = ?')
			.get(sec.id) as { env_value: string | null; env_value_enc: string | null };
		expect(row.env_value).toBeNull();
		expect(row.env_value_enc).toMatch(/^v1:/);
		expect(row.env_value_enc).not.toContain('supersecret');
		const read = await getContextItem(db, USER, sec.id);
		expect(JSON.stringify(read)).not.toContain('supersecret');
	});

	it('is a 503 to store a secret without an encryption key', async () => {
		const { t, db } = setup(false);
		const e = await fail(
			createContextItem(db, t.env, human, {
				kind: 'env',
				name: 'S',
				value: 'v',
				secret: true,
				project_id: PROJECT
			})
		);
		expect(e).toMatchObject({ status: 503, code: 'encryption_unavailable' });
	});

	it('updates: encrypts in place, refuses secret→public and value: null, replaces write-only', async () => {
		const { t, db } = setup();
		const item = await createContextItem(db, t.env, human, {
			kind: 'env',
			name: 'A',
			value: 'plain',
			project_id: PROJECT
		});
		const secret = await updateContextItem(db, t.env, human, item.id, { secret: true });
		expect(secret).toMatchObject({ secret: true, value_set: true, version: 2 });
		expect(secret.value).toBeUndefined();
		expect(
			await fail(updateContextItem(db, t.env, human, item.id, { secret: false }))
		).toMatchObject({ status: 422, code: 'secret_irreversible' });
		expect(
			await fail(
				updateContextItem(db, t.env, human, item.id, {
					value: null as unknown as string
				})
			)
		).toMatchObject({ status: 422, code: 'invalid_field' });
		const replaced = await updateContextItem(db, t.env, human, item.id, {
			value: 'newsecret',
			hint: 'new…ret'
		});
		expect(replaced).toMatchObject({ secret: true, hint: 'new…ret', version: 3 });
		expect(JSON.stringify(replaced)).not.toContain('newsecret');
		const events = t.sqlite
			.prepare("SELECT payload FROM event WHERE type = 'context.updated'")
			.all() as { payload: string }[];
		expect(events.map((e) => e.payload).join('')).not.toContain('newsecret');
		expect(events.map((e) => e.payload).join('')).not.toContain('plain');
	});

	it('fences run keys out of env writes but not reads', async () => {
		const { t, db } = setup();
		expect(
			await fail(
				createContextItem(db, t.env, runKey, {
					kind: 'env',
					name: 'A',
					value: 'x',
					project_id: PROJECT
				})
			)
		).toMatchObject({ status: 403, code: 'run_key_forbidden', details: { reason: 'env_context' } });
		const item = await createContextItem(db, t.env, human, {
			kind: 'env',
			name: 'A',
			value: 'x',
			project_id: PROJECT
		});
		expect(await fail(updateContextItem(db, t.env, runKey, item.id, { value: 'y' }))).toMatchObject(
			{
				status: 403
			}
		);
		expect(await fail(deleteContextItem(db, t.env, runKey, item.id))).toMatchObject({
			status: 403
		});
		expect((await getContextItem(db, USER, item.id)).value).toBe('x');
		// A run key can still write the other kinds.
		await createContextItem(db, t.env, runKey, {
			kind: 'prompt',
			name: 'p',
			body: 'b',
			project_id: PROJECT
		});
	});

	it('resolves per variable with override by name, counts, decrypts for delivery, and names only in the prompt', async () => {
		const { t, db } = setup();
		const issueId = addIssue(t, { state: OPEN });
		const globalTok = await createContextItem(db, t.env, human, {
			kind: 'env',
			name: 'GH_TOKEN',
			value: 'global-secret',
			secret: true
		});
		const projTok = await createContextItem(db, t.env, human, {
			kind: 'env',
			name: 'GH_TOKEN',
			value: 'project-secret',
			secret: true,
			hint: 'proj',
			project_id: PROJECT
		});
		await createContextItem(db, t.env, human, {
			kind: 'env',
			name: 'NPM_REGISTRY',
			value: 'https://r.example',
			project_id: PROJECT
		});
		const ctx = await effectiveContextForIssue(db, USER, issueId);
		expect(ctx.env.map((e) => [e.name, e.secret, e.value ?? null, e.hint])).toEqual([
			['GH_TOKEN', true, null, 'proj'],
			['NPM_REGISTRY', false, 'https://r.example', null]
		]);
		expect(ctx.overridden).toContainEqual(
			expect.objectContaining({ item_id: globalTok.id, kind: 'env', overridden_by: projTok.id })
		);
		expect(JSON.stringify(ctx)).not.toContain('-secret');
		const summary = await contextSummaryForIssue(db, USER, {
			projectId: PROJECT,
			stateId: OPEN,
			issueId
		});
		expect(summary.envs).toBe(2);

		const resolved = await resolvedEnvForIssue(db, t.env, USER, issueId);
		expect(resolved.map((e) => [e.name, e.value, e.secret])).toEqual([
			['GH_TOKEN', 'project-secret', true],
			['NPM_REGISTRY', 'https://r.example', false]
		]);
		const digest = await envDigest(resolved);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(await envDigest(resolved.map((e) => ({ ...e, value: 'other' })))).toBe(digest);
		expect(await envDigest(resolved.slice(1))).not.toBe(digest);

		const block = issueBlock({ ...issue, id: issueId }, ctx, [], []);
		expect(block).toContain(
			'Environment variables set for this run: `GH_TOKEN` (secret), `NPM_REGISTRY`.'
		);
		expect(block).not.toContain('project-secret');
		expect(block).not.toContain('r.example');
	});
});
