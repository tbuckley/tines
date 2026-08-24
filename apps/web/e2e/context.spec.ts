import type {
	ContextItem,
	EffectiveContext,
	IssueDetail,
	LaunchPromptResponse,
	ListResponse,
	Project,
	TinesEvent,
	WorkflowResponse
} from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, BOB } from './constants.mjs';
import { apiClient, body, runId } from './helpers';

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };

/**
 * The context-attachments acceptance loop (specs/context/SPEC.md): scoped
 * items, effective-context assembly across transitions, override-by-name,
 * lifecycle guards, and the launch prompt.
 */
test.describe.serial('context attachments', () => {
	const projectName = `ctx-${runId}`;
	const otherProjectName = `ctx-other-${runId}`;
	let projectId: string;
	let otherProjectId: string;
	let workflow: WorkflowResponse;
	let issueId: string;
	let otherIssueId: string;
	const stateId = (name: string) => workflow.states.find((s) => s.name === name)!.id;

	test('sets up a workflow, projects, and issues', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		workflow = await body<WorkflowResponse>(
			await api.post('/api/v1/workflows', {
				name: `ctx-flow-${runId}`,
				initial_state: 'Implementing',
				states: [
					{ name: 'Implementing', category: 'active' },
					{ name: 'Review', category: 'awaiting_human' },
					{ name: 'Done', category: 'done' }
				],
				transitions: [
					{ name: 'submit', from: 'Implementing', to: 'Review' },
					{ name: 'send back', from: 'Review', to: 'Implementing' },
					{ name: 'approve', from: 'Review', to: 'Done' }
				]
			})
		);
		projectId = (
			await body<Project>(
				await api.post('/api/v1/projects', { name: projectName, default_workflow_id: workflow.id })
			)
		).id;
		otherProjectId = (
			await body<Project>(
				await api.post('/api/v1/projects', { name: otherProjectName, default_workflow_id: workflow.id })
			)
		).id;
		issueId = (
			await body<IssueDetail>(
				await api.post(`/api/v1/projects/${projectId}/issues`, { title: 'Context target' })
			)
		).id;
		otherIssueId = (
			await body<IssueDetail>(
				await api.post(`/api/v1/projects/${otherProjectId}/issues`, { title: 'Bystander' })
			)
		).id;
	});

	test('creates scoped items and validates strictly', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const house = await api.post('/api/v1/context', {
			kind: 'prompt',
			name: 'house-conventions',
			project_id: projectId,
			body: 'House rules.'
		});
		expect(house.status()).toBe(201);
		expect((await body<ContextItem>(house)).scope.label).toBe(`project ${projectName}`);

		const skill = await api.post('/api/v1/context', {
			kind: 'skill',
			name: 'review-checklist',
			workflow_state_id: stateId('Review'),
			files: [
				{ path: 'SKILL.md', content: '# Checklist' },
				{ path: 'notes/extra.txt', content: 'more' }
			]
		});
		expect(skill.status()).toBe(201);

		const journal = await api.post('/api/v1/context', {
			kind: 'prompt',
			name: 'journal',
			project_id: projectId,
			workflow_state_id: stateId('Implementing'),
			body: 'Journal note.'
		});
		expect(journal.status()).toBe(201);
		expect((await body<ContextItem>(journal)).scope.label).toBe(
			`project ${projectName} · state Implementing`
		);

		// Strictness: unknown kind, foreign payload, missing scope, bad paths.
		expect(
			(await body<ErrorBody>(await api.post('/api/v1/context', { kind: 'widget', name: 'x', project_id: projectId })))
				.error.code
		).toBe('unknown_kind');
		expect(
			(
				await body<ErrorBody>(
					await api.post('/api/v1/context', {
						kind: 'prompt',
						name: 'x',
						project_id: projectId,
						body: 'b',
						repo_url: 'https://x'
					})
				)
			).error.code
		).toBe('kind_payload_mismatch');
		expect((await body<ErrorBody>(await api.post('/api/v1/context', { kind: 'prompt', name: 'x', body: 'b' }))).error.code).toBe(
			'scope_required'
		);
		expect(
			(
				await body<ErrorBody>(
					await api.post('/api/v1/context', {
						kind: 'skill',
						name: 'esc',
						project_id: projectId,
						files: [{ path: '../evil', content: 'x' }]
					})
				)
			).error.code
		).toBe('invalid_path');
		expect(
			(
				await body<ErrorBody>(
					await api.post('/api/v1/context', {
						kind: 'prompt',
						name: 'house-conventions',
						project_id: projectId,
						body: 'dupe'
					})
				)
			).error.code
		).toBe('duplicate_context_name');
	});

	test('assembles the effective context broad → specific and follows transitions', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		let ctx = await body<EffectiveContext>(await api.get(`/api/v1/issues/${issueId}/context`));
		expect(ctx.prompt.parts.map((p) => p.name)).toEqual(['house-conventions', 'journal']);
		expect(ctx.prompt.text).toBe(
			`## Context: project ${projectName}\n\nHouse rules.\n\n## Context: project ${projectName} · state Implementing\n\nJournal note.`
		);
		expect(ctx.skills).toEqual([]);

		// The intersection holds: a different project's issue gets nothing.
		const other = await body<EffectiveContext>(await api.get(`/api/v1/issues/${otherIssueId}/context`));
		expect(other.prompt.parts).toEqual([]);

		// Transition to Review: the journal leaves, the skill appears.
		await api.post(`/api/v1/issues/${issueId}/transition`, { action: 'submit' });
		ctx = await body<EffectiveContext>(await api.get(`/api/v1/issues/${issueId}/context`));
		expect(ctx.prompt.parts.map((p) => p.name)).toEqual(['house-conventions']);
		expect(ctx.skills.map((s) => s.name)).toEqual(['review-checklist']);
		expect(ctx.skills[0].files.map((f) => f.path)).toEqual(['SKILL.md', 'notes/extra.txt']);

		// context_summary on the issue read is post-dedupe per-kind counts.
		const issue = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
		expect(issue.context_summary).toEqual({ prompts: 1, skills: 1, repos: 0 });
	});

	test('more specific items override by name; repo dirs conflict-check', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		await api.post('/api/v1/context', {
			kind: 'repo',
			name: 'src',
			project_id: projectId,
			repo_url: 'https://github.com/acme/api.git'
		});
		await api.post('/api/v1/context', {
			kind: 'repo',
			name: 'src',
			issue_id: issueId,
			repo_url: 'https://github.com/acme/api.git',
			repo_branch: 'experiment'
		});
		const issueSkill = await body<ContextItem>(
			await api.post('/api/v1/context', {
				kind: 'skill',
				name: 'review-checklist',
				issue_id: issueId,
				files: [{ path: 'SKILL.md', content: 'override' }]
			})
		);

		const ctx = await body<EffectiveContext>(await api.get(`/api/v1/issues/${issueId}/context`));
		expect(ctx.skills.map((s) => s.item_id)).toEqual([issueSkill.id]);
		expect(ctx.repos).toHaveLength(1);
		expect(ctx.repos[0].branch).toBe('experiment');
		expect(ctx.repos[0].dir).toBe('api'); // derived from the URL
		expect(ctx.overridden.map((o) => `${o.kind}:${o.name}`).sort()).toEqual([
			'repo:src',
			'skill:review-checklist'
		]);
		expect(ctx.conflicts).toEqual([]);

		// A same-dir repo under a different name is kept but flagged.
		const clash = await body<ContextItem>(
			await api.post('/api/v1/context', {
				kind: 'repo',
				name: 'other',
				issue_id: issueId,
				repo_url: 'https://github.com/elsewhere/api.git'
			})
		);
		const withConflict = await body<EffectiveContext>(await api.get(`/api/v1/issues/${issueId}/context`));
		expect(withConflict.conflicts).toEqual([
			{ kind: 'repo_dir', dir: 'api', item_ids: expect.arrayContaining([clash.id]) }
		]);
		await api.delete(`/api/v1/context/${clash.id}`);
	});

	test('lists with scope-includes semantics and exact=true', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const all = await body<ListResponse<ContextItem>>(
			await api.get(`/api/v1/context?project=${projectId}`)
		);
		expect(all.items.map((i) => i.name).sort()).toEqual(['house-conventions', 'journal', 'src']);
		const exact = await body<ListResponse<ContextItem>>(
			await api.get(`/api/v1/context?project=${projectId}&exact=true`)
		);
		expect(exact.items.map((i) => i.name).sort()).toEqual(['house-conventions', 'src']);

		// Cross-user isolation: Bob sees none of Alice's items.
		const bob = await body<ListResponse<ContextItem>>(
			await apiClient(request, BOB.apiKey).get(`/api/v1/context?project=${projectId}`)
		);
		expect(bob.items).toEqual([]);
	});

	test('builds the launch prompt: context first, issue block last', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		await api.post(`/api/v1/issues/${issueId}/comments`, { body: 'A note.' });
		const prompt = await body<LaunchPromptResponse>(await api.get(`/api/v1/issues/${issueId}/prompt`));
		expect(prompt.text.startsWith(`## Context: project ${projectName}`)).toBe(true);
		expect(prompt.text).toContain(`## Issue: ${projectName}/1 — Context target`);
		expect(prompt.text).toContain('### Comments');
		expect(prompt.text).toContain('A note.');
		expect(prompt.text).toContain(`Add a comment: \`tines issues comment ${projectName}/1 "<markdown>"\``);
		expect(prompt.text).toContain(
			`- **send back** → Implementing (active): \`tines issues move ${projectName}/1 "send back"\``
		);
	});

	test('state removal rejects by default and force-cascades with events', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		// Empty the workflow's issues first so phase-one guards don't fire.
		await api.post(`/api/v1/issues/${issueId}/transition`, { action: 'approve' });

		const keep = workflow.states
			.filter((s) => s.name !== 'Review')
			.map((s) => ({ id: s.id, name: s.name, category: s.category }));
		const patch = { states: keep, transitions: [] };
		const rejected = await api.patch(`/api/v1/workflows/${workflow.id}`, patch);
		expect(rejected.status()).toBe(422);
		const err = (await body<ErrorBody>(rejected)).error;
		expect(err.code).toBe('context_attached');
		expect(err.details?.context_items).toEqual([
			expect.objectContaining({ kind: 'skill', name: 'review-checklist' })
		]);

		const forced = await api.patch(`/api/v1/workflows/${workflow.id}`, {
			...patch,
			force_delete_context: true
		});
		expect(forced.ok()).toBe(true);
		const updated = await body<WorkflowResponse>(forced);
		expect(updated.deleted_context).toEqual([
			expect.objectContaining({ kind: 'skill', name: 'review-checklist' })
		]);

		const events = await body<ListResponse<TinesEvent>>(await api.get('/api/v1/events?type=context.deleted'));
		expect(
			events.items.some(
				(e) => e.payload.name === 'review-checklist' && e.payload.forced === true
			)
		).toBe(true);
	});

	test('issue-scoped item events land in the project feed too', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const events = await body<ListResponse<TinesEvent>>(
			await api.get(`/api/v1/events?project=${projectId}&type=context.created`)
		);
		expect(events.items.some((e) => e.payload.name === 'src' && e.issue_id === issueId)).toBe(true);
	});
});
