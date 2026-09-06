import { repoDirFromUrl, type EffectiveContext, type IssueDetail } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import {
	buildLaunchPrompt,
	isJournal,
	issueBlock,
	layerRank,
	listContextItems,
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
	context_summary: { prompts: 0, skills: 0, repos: 0, artifacts: 0 }
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
			'**Tom Buckley** (2023-11-14T21:56:39.000Z):\nCI is red on the e2e job.'
		);
		// The steer is what this run is for, so it precedes everything the agent
		// would otherwise read first — including the full thread.
		expect(steered.indexOf('### Since the last run')).toBeLessThan(steered.indexOf('### Comments'));
		expect(steered.indexOf('Do it *well*.')).toBeLessThan(
			steered.indexOf('### Since the last run')
		);
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
