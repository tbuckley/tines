import { repoDirFromUrl, type IssueDetail } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import {
	buildLaunchPrompt,
	issueBlock,
	layerRank,
	scopeLabel,
	stitchPrompt,
	validateWorkspacePath
} from './context';
import { ApiFail } from './core';

describe('layerRank', () => {
	it('orders the seven scopes exactly as the spec enumerates them', () => {
		const scopes = [
			{ projectId: 'p' }, // 1. project
			{ workflowStateId: 's' }, // 2. state
			{ projectId: 'p', workflowStateId: 's' }, // 3. project ∧ state
			{ issueId: 'i' }, // 4. issue
			{ issueId: 'i', projectId: 'p' }, // 5. issue ∧ project
			{ issueId: 'i', workflowStateId: 's' }, // 6. issue ∧ state
			{ issueId: 'i', projectId: 'p', workflowStateId: 's' } // 7. all three
		];
		expect(scopes.map(layerRank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
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
	scheduled_task_id: null,
	scheduled_task_name: null,
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

describe('issueBlock', () => {
	it('renders the factual block with runnable CLI commands', () => {
		const block = issueBlock(issue);
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
		const block = issueBlock({ ...issue, comments: [], allowed_transitions: [] });
		expect(block).toContain('No comments yet.');
		expect(block).toContain('None — this state is terminal.');
	});
});

describe('buildLaunchPrompt', () => {
	it('puts the context first and the issue block last', () => {
		const text = buildLaunchPrompt('## Context: project Tines\n\nHouse rules.', issue);
		expect(text.startsWith('## Context: project Tines')).toBe(true);
		expect(text.indexOf('## Issue:')).toBeGreaterThan(text.indexOf('House rules.'));
	});

	it('is just the issue block when no context applies', () => {
		expect(buildLaunchPrompt('', issue).startsWith('## Issue:')).toBe(true);
	});
});
