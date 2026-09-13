import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EffectiveContext, IssueDetail } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { buildLaunchPrompt, buildResumePrompt, selectLaunchComments } from '../../context';

const dir = dirname(fileURLToPath(import.meta.url));
const input = JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8'));
const human = { user_id: 'u1', user_name: 'Fixture Human', api_key_id: null, api_key_name: null };
const comments = input.issue.comments.map((comment: Record<string, unknown>) => ({
	id: comment.id,
	issue_id: 'iss_fixture',
	body: comment.body,
	created_at: comment.created_at,
	updated_at: null,
	actor:
		comment.kind === 'human'
			? human
			: {
					...human,
					api_key_id: `key_${comment.run_id}`,
					api_key_name: String(comment.run_id),
					run: {
						run_id: comment.run_id,
						runner_name: 'fixture-runner',
						issue_ref: {
							project_name: 'Fixture Project',
							number: comment.run_issue_number
						}
					}
				}
}));

const issue = {
	id: 'iss_fixture',
	project_id: 'prj_fixture',
	project_name: input.issue.project_name,
	project_archived_at: null,
	number: input.issue.number,
	title: input.issue.title,
	description: input.issue.description,
	labels: [{ id: 'lbl_perf', name: 'performance', color: 'blue' }],
	arrived_via: null,
	workflow_id: 'wf_fixture',
	state: {
		id: 's_impl',
		name: 'Implementation',
		category: 'active',
		position: 0,
		inherits_from: null
	},
	effective_state: {
		id: 's_impl',
		name: 'Implementation',
		category: 'active',
		position: 0,
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
	attempt_count: 1,
	needs_attention: false,
	active_run: null,
	created_at: input.fixed_clock - 10000,
	updated_at: input.fixed_clock,
	last_activity_at: input.fixed_clock,
	workflow: {
		id: 'wf_fixture',
		name: 'Engineering',
		description: '',
		is_system: false,
		initial_state_id: 's_impl',
		states: [],
		transitions: [],
		issue_count: 1,
		created_at: 0,
		updated_at: 0
	},
	comments,
	allowed_transitions: [],
	state_entered_at: input.fixed_clock - 5000,
	context_summary: { prompts: 0, skills: 1, repos: 0, artifacts: 1 },
	launch_comments: input.issue.launch_comments
} as IssueDetail;

const context = {
	prompt: {
		text: '',
		parts: [],
		journal: { state_id: 's_impl', inherited_from: null, item_id: null, version: null }
	},
	skills: [
		{
			item_id: 'ctx_fixture',
			name: 'fixture-skill',
			description: input.effective_context.description,
			scope: {
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
			},
			files: [
				{ path: 'SKILL.md', content: input.effective_context.skill_body },
				{ path: 'support.txt', content: input.effective_context.supporting_file }
			],
			file_count: 2,
			version: 1,
			inherited_from: null
		}
	],
	repos: [],
	overridden: [],
	conflicts: []
} as EffectiveContext;
const emptyContext = { ...context, skills: [] };
const fullIssue = { ...issue, launch_comments: undefined };
const artifacts = input.artifacts.map((artifact: Record<string, unknown>) => ({
	id: 'art_fixture',
	issue_id: 'iss_fixture',
	name: artifact.name,
	description: '',
	artifact_type: artifact.artifact_type,
	fresh: true,
	created_at: 0,
	updated_at: 0,
	current_version: {
		id: 'av_fixture',
		artifact_id: 'art_fixture',
		version: artifact.version,
		content_type: 'text/markdown',
		created_at: 0
	}
}));

// Fixture-only transform: recreates the two presentation details at the pinned
// baseline commit. It is not exported or used by the production renderer.
function legacyPresentation(
	text: string,
	changes: { comments?: boolean; skill?: boolean } = {}
): string {
	let result = changes.comments ? text.replace(/, ID: cmt_[^)]+(?=\):)/g, '') : text;
	if (changes.skill) {
		result = result.replace(
			/\n\n### Skills\n\n[\s\S]*$/,
			`\n\nAttached to this issue: skill "fixture-skill" (2 files). Fetch them: \`tines issues context ${issue.project_name}/${issue.number} --out <dir>\``
		);
	}
	return result;
}

const outputs: Record<string, string> = {
	'comment-only.before.md': legacyPresentation(
		buildLaunchPrompt(emptyContext, fullIssue, artifacts, input.label_vocabulary),
		{ comments: true }
	),
	'comment-only.after.md': buildLaunchPrompt(
		emptyContext,
		issue,
		artifacts,
		input.label_vocabulary
	),
	'skill-only.before.md': legacyPresentation(
		buildLaunchPrompt(context, fullIssue, artifacts, input.label_vocabulary),
		{ skill: true }
	),
	'skill-only.after.md': buildLaunchPrompt(context, fullIssue, artifacts, input.label_vocabulary),
	'combined.cold.before.md': legacyPresentation(
		buildLaunchPrompt(context, fullIssue, artifacts, input.label_vocabulary),
		{ comments: true, skill: true }
	),
	'combined.cold.after.md': buildLaunchPrompt(context, issue, artifacts, input.label_vocabulary),
	'combined.resume.before.md': legacyPresentation(
		buildResumePrompt(context, fullIssue, artifacts, input.label_vocabulary),
		{ comments: true, skill: true }
	),
	'combined.resume.after.md': buildResumePrompt(context, issue, artifacts, input.label_vocabulary)
};

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const measured = () => ({
	...outputs,
	'input.json': readFileSync(join(dir, 'input.json'), 'utf8'),
	'retrieval-command.txt': readFileSync(join(dir, 'retrieval-command.txt'), 'utf8'),
	'retrieval.stdout.txt': readFileSync(join(dir, 'retrieval.stdout.txt'), 'utf8'),
	'retrieval.stderr.txt': readFileSync(join(dir, 'retrieval.stderr.txt'), 'utf8')
});

describe('launch-context comparison fixtures', () => {
	it('match the real candidate builders and expected selection', () => {
		if (process.env.UPDATE_LAUNCH_CONTEXT_FIXTURES === '1') {
			for (const [name, text] of Object.entries(outputs)) writeFileSync(join(dir, name), text);
			writeFileSync(
				join(dir, 'hashes.json'),
				JSON.stringify(
					Object.fromEntries(
						Object.entries(measured()).map(([name, text]) => [
							name,
							{ sha256: hash(text), bytes: Buffer.byteLength(text) }
						])
					),
					null,
					'\t'
				) + '\n'
			);
		}
		for (const [name, text] of Object.entries(outputs))
			expect(readFileSync(join(dir, name), 'utf8'), name).toBe(text);
		const hashes = JSON.parse(readFileSync(join(dir, 'hashes.json'), 'utf8'));
		for (const [name, text] of Object.entries(measured()))
			expect(hashes[name]).toEqual({ sha256: hash(text), bytes: Buffer.byteLength(text) });
		expect(selectLaunchComments(issue).retained.map((comment) => comment.id)).toEqual(
			input.expected.selected_ids
		);
		expect(selectLaunchComments(issue).omittedAgentIds).toEqual(input.expected.omitted_ids);
		const skillBefore = outputs['skill-only.before.md'];
		const skillAfter = outputs['skill-only.after.md'];
		expect(skillBefore).toContain('Attached to this issue: skill "fixture-skill" (2 files).');
		expect(skillBefore).not.toContain('### Skills');
		expect(skillAfter).toContain('### Skills');
		expect(skillAfter).not.toContain('Attached to this issue: skill "fixture-skill" (2 files).');
		expect(skillBefore.slice(0, skillBefore.indexOf('\n\nAttached to this issue: skill'))).toBe(
			skillAfter.slice(0, skillAfter.indexOf('\n\n### Skills'))
		);
		for (const name of ['combined.cold.before.md', 'combined.resume.before.md']) {
			expect(outputs[name]).toContain('Attached to this issue: skill "fixture-skill" (2 files).');
			expect(outputs[name]).not.toContain('### Skills');
		}
	});
});
