import { repoDirFromUrl, type EffectiveContext, type IssueDetail } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import {
	buildLaunchPrompt,
	isJournal,
	issueBlock,
	layerRank,
	scopeLabel,
	stitchPrompt,
	validateWorkspacePath
} from './context';
import { ApiFail } from './core';

describe('layerRank', () => {
	it('orders the eight scopes exactly as the spec enumerates them', () => {
		const scopes = [
			{}, // 0. global (empty scope)
			{ projectId: 'p' }, // 1. project
			{ workflowStateId: 's' }, // 2. state
			{ projectId: 'p', workflowStateId: 's' }, // 3. project ∧ state
			{ issueId: 'i' }, // 4. issue
			{ issueId: 'i', projectId: 'p' }, // 5. issue ∧ project
			{ issueId: 'i', workflowStateId: 's' }, // 6. issue ∧ state
			{ issueId: 'i', projectId: 'p', workflowStateId: 's' } // 7. all three
		];
		expect(scopes.map(layerRank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	it('puts any issue-anchored scope after any non-issue-anchored one', () => {
		expect(layerRank({ issueId: 'i' })).toBeGreaterThan(
			layerRank({ projectId: 'p', workflowStateId: 's' })
		);
	});
});

describe('scopeLabel', () => {
	it('renders set dimensions in project · state · issue order', () => {
		expect(
			scopeLabel({ projectName: 'Tines', stateName: 'Review', issueProjectName: 'Tines', issueNumber: 42 })
		).toBe('project Tines · state Review · issue Tines/42');
	});

	it('renders single dimensions without separators', () => {
		expect(scopeLabel({ projectName: 'Tines' })).toBe('project Tines');
		expect(scopeLabel({ stateName: 'Review' })).toBe('state Review');
		expect(scopeLabel({ issueProjectName: 'Tines', issueNumber: 7 })).toBe('issue Tines/7');
	});

	it('labels the empty scope "global"', () => {
		expect(scopeLabel({})).toBe('global');
	});
});

describe('isJournal', () => {
	const base = { kind: 'prompt', name: 'journal', project_id: 'p', workflow_state_id: 's', issue_id: null };
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
	number: 42,
	title: 'Ship the thing',
	description: 'Do it *well*.',
	workflow_id: 'wf_1',
	state: { id: 's_review', name: 'Review', category: 'awaiting_human', position: 1 },
	effective_state: { id: 's_review', name: 'Review', category: 'awaiting_human', position: 1 },
	duplicate_of: null,
	open_blockers: [],
	links: { blocked_by: [], blocks: [], duplicate_of: null, duplicated_by: [] },
	scheduled_task_id: null,
	scheduled_task_name: null,
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
			created_at: 1700000000000
		}
	],
	allowed_transitions: [
		{
			transition_id: 't1',
			name: 'send back',
			to_state: { id: 's_open', name: 'Open', category: 'active', position: 0 }
		}
	],
	context_summary: { prompts: 0, skills: 0, repos: 0 }
};

const emptyScope = {
	project_id: null,
	project_name: null,
	workflow_state_id: null,
	workflow_state_name: null,
	workflow_id: null,
	workflow_name: null,
	issue_id: null,
	issue_ref: null,
	label: 'global'
};

const emptyContext: EffectiveContext = {
	prompt: { text: '', parts: [] },
	skills: [],
	repos: [],
	overridden: [],
	conflicts: []
};

const richContext: EffectiveContext = {
	prompt: {
		text: '## Context: global\n\nGuidance.\n\n## Journal (project Tines · state Review)\n\n- lesson',
		parts: [
			{
				item_id: 'ctx_g',
				name: 'agent-guidelines',
				scope: emptyScope,
				body: 'Guidance.',
				version: 4,
				is_journal: false
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
				is_journal: true
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
				is_journal: false
			}
		]
	},
	skills: [
		{
			item_id: 'ctx_s',
			name: 'review-checklist',
			scope: { ...emptyScope, workflow_state_id: 's_review', workflow_state_name: 'Review', label: 'state Review' },
			files: [{ path: 'SKILL.md', content: 'x' }],
			file_count: 1,
			version: 2
		}
	],
	repos: [
		{
			item_id: 'ctx_r',
			name: 'src',
			scope: { ...emptyScope, issue_id: 'iss_1', issue_ref: { project_name: 'Tines', number: 42 }, label: 'issue Tines/42' },
			url: 'https://github.com/acme/api.git',
			branch: 'experiment',
			dir: 'api',
			version: 1
		}
	],
	overridden: [],
	conflicts: []
};

describe('issueBlock', () => {
	it('renders the factual block with runnable CLI commands', () => {
		const block = issueBlock(issue, emptyContext);
		expect(block).toContain('## Issue: Tines/42 — Ship the thing');
		expect(block).toContain('Do it *well*.');
		expect(block).toContain('Review (awaiting_human), in workflow "Two-step".');
		expect(block).toContain('**Alice via laptop** (2023-11-14T22:13:20.000Z):\nLooks close.');
		expect(block).toContain('Add a comment: `tines issues comment Tines/42 "<markdown>"`');
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
		expect(withJournal).toContain('`tines journal rewrite Tines/42 --body @file --expect-version 7`');
		expect(withJournal).not.toContain('ctx_'); // no item ids anywhere

		const without = issueBlock(issue, emptyContext);
		expect(without).toContain('No journal exists yet for project Tines · state Review. Start one:');
	});

	it('lists artifacts with the fetch command and shared prompts names-only', () => {
		const block = issueBlock(issue, richContext);
		expect(block).toContain(
			'Attached to this issue: skill "review-checklist" (1 file), repo "src" (branch experiment). Fetch them: `tines issues context Tines/42 --out <dir>`'
		);
		// Shared footnote: global + non-journal, non-issue-anchored prompts —
		// the issue-scoped "constraints" prompt is the issue's own, not listed.
		expect(block).toContain('Also in effect: prompt "agent-guidelines" (global)');
		expect(block).not.toContain('"constraints"');
		expect(block).toContain('file an issue titled `Context change: <scope label>`');
	});
});

describe('buildLaunchPrompt', () => {
	it('puts the context first and the issue block last', () => {
		const text = buildLaunchPrompt(richContext, issue);
		expect(text.startsWith('## Context: global')).toBe(true);
		expect(text.indexOf('## Issue:')).toBeGreaterThan(text.indexOf('## Journal (project Tines · state Review)'));
	});

	it('is just the issue block when no context applies', () => {
		expect(buildLaunchPrompt(emptyContext, issue).startsWith('## Issue:')).toBe(true);
	});
});
