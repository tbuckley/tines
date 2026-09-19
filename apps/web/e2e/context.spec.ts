import type {
	ContextItem,
	EffectiveContext,
	IssueDetail,
	IssueJournalResponse,
	LaunchPromptResponse,
	ListResponse,
	Project,
	TinesEvent,
	WorkflowResponse
} from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, BOB, RUNROW } from './constants.mjs';
import { apiClient, body, errorBody, gotoHydrated, issuePath, runId, signIn } from './helpers';

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
				await api.post('/api/v1/projects', {
					name: otherProjectName,
					default_workflow_id: workflow.id
				})
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
			(
				await errorBody(
					await api.post('/api/v1/context', { kind: 'widget', name: 'x', project_id: projectId })
				)
			).error.code
		).toBe('unknown_kind');
		expect(
			(
				await errorBody(
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
		// An empty scope is not an error: it is global (AGENT_EDITING.md).
		// Created and removed here so it doesn't color other suites' prompts.
		const globalRes = await api.post('/api/v1/context', {
			kind: 'prompt',
			name: `g-${runId}`,
			body: 'b'
		});
		expect(globalRes.status()).toBe(201);
		const globalItem = await body<ContextItem>(globalRes);
		expect(globalItem.scope.label).toBe('global');
		await api.delete(`/api/v1/context/${globalItem.id}`);
		expect(
			(
				await errorBody(
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
				await errorBody(
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
		// The journal-named item takes the special display heading.
		expect(ctx.prompt.text).toBe(
			`## Context: project ${projectName}\n\nHouse rules.\n\n## Journal (project ${projectName} · state Implementing)\n\nJournal note.`
		);
		expect(ctx.skills).toEqual([]);

		// The intersection holds: a different project's issue gets nothing.
		const other = await body<EffectiveContext>(
			await api.get(`/api/v1/issues/${otherIssueId}/context`)
		);
		expect(other.prompt.parts).toEqual([]);

		// Transition to Review: the journal leaves, the skill appears.
		await api.post(`/api/v1/issues/${issueId}/transition`, { action: 'submit' });
		ctx = await body<EffectiveContext>(await api.get(`/api/v1/issues/${issueId}/context`));
		expect(ctx.prompt.parts.map((p) => p.name)).toEqual(['house-conventions']);
		expect(ctx.skills.map((s) => s.name)).toEqual(['review-checklist']);
		expect(ctx.skills[0].files.map((f) => f.path)).toEqual(['SKILL.md', 'notes/extra.txt']);

		// context_summary on the issue read is post-dedupe per-kind counts.
		const issue = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
		expect(issue.context_summary).toEqual({
			prompts: 1,
			skills: 1,
			repos: 0,
			artifacts: 0,
			envs: 0
		});
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
		const withConflict = await body<EffectiveContext>(
			await api.get(`/api/v1/issues/${issueId}/context`)
		);
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
		const prompt = await body<LaunchPromptResponse>(
			await api.get(`/api/v1/issues/${issueId}/prompt`)
		);
		expect(prompt.text.startsWith(`## Context: project ${projectName}`)).toBe(true);
		expect(prompt.text).toContain(`## Issue: ${projectName}/1 — Context target`);
		expect(prompt.text).toContain('### Comments');
		expect(prompt.text).toContain('A note.');
		expect(prompt.text).toContain(`tines issues comment ${projectName}/1 - <<'EOF'`);
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
		const err = (await errorBody(rejected)).error;
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

		const events = await body<ListResponse<TinesEvent>>(
			await api.get('/api/v1/events?type=context.deleted')
		);
		expect(
			events.items.some((e) => e.payload.name === 'review-checklist' && e.payload.forced === true)
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

/**
 * Agent-maintained context (specs/context/AGENT_EDITING.md): global scope,
 * creation-time prompts, the journal (append, CAS, special heading), and
 * the id-free launch prompt.
 */
test.describe.serial('env context items', () => {
	// Variables delivered to runs (specs/context/SPEC.md "Env items"): the
	// value is the payload, a secret is write-only and encrypted, and no read
	// surface — item, list, effective context, launch prompt — carries it.
	const projectName = `ctx-env-${runId}`;
	const secretValue = `e2e-secret-${runId}-plaintext`;
	const issueSecretValue = `e2e-issue-secret-${runId}-plaintext`;
	let projectId: string;
	let issue: IssueDetail;
	let publicItem: ContextItem;
	let secretItem: ContextItem;

	test('creates public and secret items; foreign fields, bad names and un-secreting are rejected', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		projectId = (await body<Project>(await api.post('/api/v1/projects', { name: projectName }))).id;
		issue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${projectId}/issues`, { title: 'Env target' })
		);

		const pub = await api.post('/api/v1/context', {
			kind: 'env',
			name: 'NPM_REGISTRY',
			project_id: projectId,
			value: 'https://r.example'
		});
		expect(pub.status()).toBe(201);
		publicItem = await body<ContextItem>(pub);
		expect(publicItem).toMatchObject({
			kind: 'env',
			name: 'NPM_REGISTRY',
			value: 'https://r.example',
			secret: false,
			value_set: true,
			hint: null
		});

		const sec = await api.post('/api/v1/context', {
			kind: 'env',
			name: 'GH_TOKEN',
			project_id: projectId,
			value: secretValue,
			secret: true,
			hint: 'e2e…text'
		});
		expect(sec.status()).toBe(201);
		secretItem = await body<ContextItem>(sec);
		expect(secretItem).toMatchObject({
			kind: 'env',
			name: 'GH_TOKEN',
			secret: true,
			value_set: true,
			hint: 'e2e…text'
		});
		expect(secretItem).not.toHaveProperty('value');
		// Reading it back shows only that it is set, plus the hint.
		const shown = await api.get(`/api/v1/context/${secretItem.id}`);
		expect(shown.status()).toBe(200);
		const shownText = await shown.text();
		expect(shownText).not.toContain(secretValue);
		expect(JSON.parse(shownText)).toMatchObject({ value_set: true, hint: 'e2e…text' });

		// Foreign fields, both directions.
		const code = async (payload: Record<string, unknown>) =>
			(await errorBody(await api.post('/api/v1/context', payload))).error.code;
		expect(
			await code({ kind: 'env', name: 'X', project_id: projectId, value: 'v', body: 'prose' })
		).toBe('kind_payload_mismatch');
		expect(
			await code({ kind: 'prompt', name: 'x', project_id: projectId, body: 'b', value: 'v' })
		).toBe('kind_payload_mismatch');
		// The name is the variable name: shell-safe, and never Tines' own.
		expect(await code({ kind: 'env', name: 'lower-case', project_id: projectId, value: 'v' })).toBe(
			'invalid_field'
		);
		expect(
			await code({ kind: 'env', name: 'TINES_API_KEY', project_id: projectId, value: 'v' })
		).toBe('reserved_name');
		expect(await code({ kind: 'env', name: 'PATH', project_id: projectId, value: 'v' })).toBe(
			'reserved_name'
		);
		// A secret cannot be made public again.
		expect(
			(await errorBody(await api.patch(`/api/v1/context/${secretItem.id}`, { secret: false })))
				.error.code
		).toBe('secret_irreversible');
	});

	test('the more specific item wins by name, and no read surface carries a secret', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		const issueScoped = await api.post('/api/v1/context', {
			kind: 'env',
			name: 'GH_TOKEN',
			issue_id: issue.id,
			value: issueSecretValue,
			secret: true
		});
		expect(issueScoped.status()).toBe(201);
		const winner = await body<ContextItem>(issueScoped);

		const ctxRes = await api.get(`/api/v1/issues/${issue.id}/context`);
		expect(ctxRes.status()).toBe(200);
		const ctxText = await ctxRes.text();
		expect(ctxText).not.toContain(secretValue);
		expect(ctxText).not.toContain(issueSecretValue);
		const ctx = JSON.parse(ctxText) as EffectiveContext;
		expect(ctx.env.map((e) => [e.name, e.item_id, e.secret, e.value ?? null]).sort()).toEqual([
			['GH_TOKEN', winner.id, true, null],
			['NPM_REGISTRY', publicItem.id, false, 'https://r.example']
		]);
		expect(ctx.overridden.map((o) => `${o.kind}:${o.name}`)).toContain('env:GH_TOKEN');

		// The launch prompt names the variables and nothing more.
		const promptRes = await api.get(`/api/v1/issues/${issue.id}/prompt`);
		const promptText = await promptRes.text();
		expect(promptText).not.toContain(secretValue);
		expect(promptText).not.toContain(issueSecretValue);
		const prompt = JSON.parse(promptText) as LaunchPromptResponse;
		expect(prompt.text).toMatch(/Environment variables set for this run: .*`GH_TOKEN` \(secret\)/);
		expect(prompt.text).toMatch(/Environment variables set for this run: .*`NPM_REGISTRY`/);
		expect(prompt.text).not.toContain('https://r.example');

		// The list and the issue's own items: same gate.
		const listText = await (await api.get(`/api/v1/context?project=${projectId}`)).text();
		expect(listText).toContain('GH_TOKEN');
		expect(listText).not.toContain(secretValue);
		expect(listText).not.toContain(issueSecretValue);
	});

	test('a run key reads env items but cannot create, edit or delete them', async ({ request }) => {
		const runKeyed = apiClient(request, RUNROW.runKey);
		const create = await runKeyed.post('/api/v1/context', {
			kind: 'env',
			name: 'PLANTED',
			project_id: projectId,
			value: 'x'
		});
		expect(create.status()).toBe(403);
		expect((await errorBody(create)).error.code).toBe('run_key_forbidden');
		const edit = await runKeyed.patch(`/api/v1/context/${publicItem.id}`, { value: 'y' });
		expect(edit.status()).toBe(403);
		const del = await runKeyed.delete(`/api/v1/context/${publicItem.id}`);
		expect(del.status()).toBe(403);
		// Reads stay open: they never carry a secret.
		const read = await runKeyed.get(`/api/v1/context/${secretItem.id}`);
		expect(read.status()).toBe(200);
		expect(await read.text()).not.toContain(secretValue);
		// The owner's items are untouched.
		expect(
			(
				await body<ContextItem>(
					await apiClient(request, ALICE.apiKey).get(`/api/v1/context/${publicItem.id}`)
				)
			).value
		).toBe('https://r.example');
	});

	test('the issue page editor creates a secret item and shows it as set, never its value', async ({
		page,
		context
	}) => {
		await signIn(context, ALICE.sessionToken);
		await gotoHydrated(page, issuePath(projectName, issue.number));
		const section = page
			.locator('section')
			.filter({ has: page.getByRole('button', { name: 'View launch prompt' }) });
		await section.getByRole('button', { name: 'Add' }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByLabel('Name', { exact: true })).toBeVisible();
		await dialog.getByText('Env — an environment variable').click();
		await dialog.getByLabel('Name', { exact: true }).fill('E2E_UI_SECRET');
		await dialog.getByLabel('Secret (encrypted at rest, write-only)').check();
		await dialog.getByLabel('Value', { exact: true }).fill('ui-secret-value');
		await dialog.getByLabel('Hint', { exact: true }).fill('ui…hint');
		await dialog.getByRole('button', { name: 'Create' }).click();

		await expect(
			page.locator('li:not([inert])').filter({ hasText: 'E2E_UI_SECRET · secret · set · ui…hint' })
		).toBeVisible();
		await page.getByText('Effective context', { exact: false }).first().click();
		const envSection = page.getByRole('heading', { name: 'Environment' }).locator('..');
		await expect(envSection).toBeVisible();
		await expect(envSection.getByText('E2E_UI_SECRET', { exact: true })).toBeVisible();
		await expect(envSection).toContainText('secret · set · ui…hint');
		expect(await page.content()).not.toContain('ui-secret-value');
	});
});

test.describe.serial('agent-maintained context', () => {
	const projectName = `agent-${runId}`;
	let projectId: string;
	let workflow: WorkflowResponse;
	let issueId: string;
	let issueRef: string;
	let globalId: string;
	let journalId: string;

	test('workflow states seed their instructions; existing states reject prompt', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		workflow = await body<WorkflowResponse>(
			await api.post('/api/v1/workflows', {
				name: `agent-flow-${runId}`,
				initial_state: 'Working',
				states: [
					{ name: 'Working', category: 'active', prompt: 'Working means shipping.' },
					{ name: 'Done', category: 'done' }
				],
				transitions: [{ name: 'finish', from: 'Working', to: 'Done' }]
			})
		);
		const workingId = workflow.states.find((s) => s.name === 'Working')!.id;
		const items = await body<ListResponse<ContextItem>>(
			await api.get(`/api/v1/context?state=${workingId}&exact=true`)
		);
		expect(items.items.map((i) => i.name)).toEqual(['instructions']);
		expect(items.items[0].scope.label).toBe('state Working');

		// prompt on an existing state is rejected — context surfaces own edits.
		const rejected = await api.patch(`/api/v1/workflows/${workflow.id}`, {
			states: workflow.states.map((s) => ({
				id: s.id,
				name: s.name,
				category: s.category,
				prompt: 'nope'
			}))
		});
		expect(rejected.status()).toBe(422);
		expect((await errorBody(rejected)).error.code).toBe('prompt_on_existing_state');
	});

	test('project creation seeds its conventions atomically', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const project = await body<Project>(
			await api.post('/api/v1/projects', {
				name: projectName,
				default_workflow_id: workflow.id,
				initial_prompt: 'House rules for agents.'
			})
		);
		projectId = project.id;
		const items = await body<ListResponse<ContextItem>>(
			await api.get(`/api/v1/context?project=${projectId}&exact=true`)
		);
		expect(items.items.map((i) => i.name)).toEqual(['conventions']);

		const issue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${projectId}/issues`, { title: 'Agent target' })
		);
		issueId = issue.id;
		issueRef = `${projectName}/${issue.number}`;
	});

	test('a global item stitches first, under "## Context: global"', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const created = await api.post('/api/v1/context', {
			kind: 'prompt',
			name: `guidance-${runId}`,
			body: 'Global guidance.'
		});
		expect(created.status()).toBe(201);
		const item = await body<ContextItem>(created);
		globalId = item.id;
		expect(item.scope.label).toBe('global');
		expect(item.version).toBe(1);

		const ctx = await body<EffectiveContext>(await api.get(`/api/v1/issues/${issueId}/context`));
		expect(ctx.prompt.parts[0].name).toBe(`guidance-${runId}`);
		expect(ctx.prompt.text.startsWith('## Context: global\n\nGlobal guidance.')).toBe(true);
	});

	test('the journal appends atomically, CAS-rewrites, and renders as "## Journal"', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		const workingId = workflow.states.find((s) => s.name === 'Working')!.id;
		const journal = await body<ContextItem>(
			await api.post('/api/v1/context', {
				kind: 'prompt',
				name: 'journal',
				project_id: projectId,
				workflow_state_id: workingId,
				body: '- day 1: first lesson'
			})
		);
		journalId = journal.id;

		// Append: blank-line separated, version bumped, appended event flag.
		const appended = await body<ContextItem>(
			await api.post(`/api/v1/context/${journalId}/append`, { text: '- day 2: second lesson' })
		);
		expect(appended.version).toBe(2);
		expect(appended.body).toBe('- day 1: first lesson\n\n- day 2: second lesson');

		// Stale CAS → 409 carrying the current item; fresh CAS lands.
		const stale = await api.patch(`/api/v1/context/${journalId}`, {
			body: '- rewritten',
			expected_version: 1
		});
		expect(stale.status()).toBe(409);
		const conflict = (await errorBody(stale)).error;
		expect(conflict.code).toBe('version_conflict');
		expect((conflict.details?.current as ContextItem).version).toBe(2);
		const rewritten = await body<ContextItem>(
			await api.patch(`/api/v1/context/${journalId}`, { body: '- rewritten', expected_version: 2 })
		);
		expect(rewritten.version).toBe(3);

		// Appending to a non-prompt is refused.
		const skill = await body<ContextItem>(
			await api.post('/api/v1/context', {
				kind: 'skill',
				name: `sk-${runId}`,
				description: 'Use this when the issue needs the synthetic review procedure.',
				issue_id: issueId,
				files: [{ path: 'SKILL.md', content: 'x' }]
			})
		);
		expect((await api.post(`/api/v1/context/${skill.id}/append`, { text: 'x' })).status()).toBe(
			422
		);

		const ctx = await body<EffectiveContext>(await api.get(`/api/v1/issues/${issueId}/context`));
		expect(ctx.prompt.text).toContain(
			`## Journal (project ${projectName} · state Working)\n\n- rewritten`
		);
		const part = ctx.prompt.parts.find((p) => p.is_journal)!;
		expect(part.version).toBe(3);
		expect(ctx.skills[0].description).toBe(
			'Use this when the issue needs the synthetic review procedure.'
		);
		expect(ctx.skills[0].files).toEqual([{ path: 'SKILL.md', content: 'x' }]);
	});

	test('the journal endpoint names the scope a caller owns, and is per-user', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		// A PAT is not a run, so it gets the issue's current state. (Run keys
		// anchor to their launch state — unit-tested, since minting one here
		// would mean driving the whole runner protocol.)
		const resolved = await body<IssueJournalResponse>(
			await api.get(`/api/v1/issues/${issueId}/journal`)
		);
		expect(resolved.anchor).toBe('current');
		expect(resolved.note).toBeNull();
		expect(resolved.scope.label).toBe(`project ${projectName} · state Working`);
		expect(resolved.item?.id).toBe(journalId);

		const bob = apiClient(request, BOB.apiKey);
		expect((await bob.get(`/api/v1/issues/${issueId}/journal`)).status()).toBe(404);
	});

	test('the launch prompt keeps context IDs private and describes readable skills', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		const prompt = await body<LaunchPromptResponse>(
			await api.get(`/api/v1/issues/${issueId}/prompt`)
		);
		expect(prompt.text).not.toContain('ctx_');
		expect(prompt.text).toContain('### Journal');
		expect(prompt.text).toContain(
			"Appends land in this stage's journal even after you move the issue."
		);
		expect(prompt.text).toContain(`\`tines journal append ${issueRef} "- <date>: <lesson>"\``);
		expect(prompt.text).toContain(`--expect-version 3`);
		expect(prompt.text).toContain(
			`Skill "sk-${runId}" (issue ${issueRef}): read \`skills/sk-${runId}/SKILL.md\` when this applies: Use this when the issue needs the synthetic review procedure.`
		);
		expect(prompt.text).toContain(`tines issues context ${issueRef} --json`);
		expect(prompt.text).toContain(`Also in effect: prompt "guidance-${runId}" (global)`);
		expect(prompt.text).toContain('file an issue titled `Context change: <scope label>`');

		// Keep later suites clean: the global item affects every launch prompt.
		await api.delete(`/api/v1/context/${globalId}`);
	});
});

/**
 * The Context page's state chips. A real library has an `instructions` prompt
 * for every state of every workflow, so "Review" alone names dozens of rows —
 * the chip has to carry the workflow, and the filter row has to narrow by it.
 */
test.describe.serial('context list state chips', () => {
	const engName = `Chip Eng ${runId}`;
	const qaName = `Chip QA ${runId}`;
	let eng: WorkflowResponse;
	let qa: WorkflowResponse;

	const flow = (name: string) => ({
		name,
		initial_state: 'Review',
		states: [
			{ name: 'Review', category: 'active', prompt: `Instructions for ${name}.` },
			{ name: 'Done', category: 'done' }
		],
		transitions: [{ name: 'finish', from: 'Review', to: 'Done' }]
	});

	test('sets up two workflows that share a state name', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		eng = await body<WorkflowResponse>(await api.post('/api/v1/workflows', flow(engName)));
		qa = await body<WorkflowResponse>(await api.post('/api/v1/workflows', flow(qaName)));
		// One seeded item each: the Review state's instructions.
		for (const wf of [eng, qa]) {
			const reviewId = wf.states.find((s) => s.name === 'Review')!.id;
			const items = await body<ListResponse<ContextItem>>(
				await api.get(`/api/v1/context?state=${reviewId}`)
			);
			expect(items.items.map((i) => i.name)).toEqual(['instructions']);
		}
	});

	test('the chip names the workflow, and the Workflow filter narrows to it', async ({
		page,
		context
	}) => {
		await signIn(context, ALICE.sessionToken);
		await gotoHydrated(page, `/context?workflow=${eng.id}`);
		// `li:not([inert])`: the old row outros for 180 ms after a filter change
		// (`transition:slide` in ContextItemList.svelte), and Svelte 5 marks an
		// outroing element `inert` while it is still a sibling of the new row inside
		// the same live <ul>. Excluding it keeps this locator at exactly one element
		// at every instant, so each assertion below auto-retries against the live row
		// instead of tripping strict mode on the stale one (Tines/154).
		const row = page.locator('li:not([inert])').filter({ hasText: 'instructions' });
		await expect(row).toHaveCount(1);
		await expect(row).toContainText(`${engName} / Review`);

		// Switching the filter re-runs the load and swaps in the other workflow's
		// item — same name, different chip.
		const select = page.getByLabel('Filter by workflow');
		await expect(async () => {
			await select.selectOption(qa.id);
			await expect(page).toHaveURL(new RegExp(`workflow=${qa.id}`));
		}).toPass({ timeout: 15_000 });
		await expect(row).toHaveCount(1);
		await expect(row).toContainText(`${qaName} / Review`);
		await expect(row).not.toContainText(engName);
	});

	test('a chip too long for its cap truncates with an ellipsis, not mid-glyph', async ({
		page,
		context,
		request
	}) => {
		// The chip is `inline-flex`, and `text-overflow` only applies to a block
		// container's own inline text — so `truncate` on the chip itself kept the
		// `overflow: hidden` half and dropped the ellipsis, clipping names
		// mid-glyph (Tines/221). Assert on the mechanism rather than the glyph,
		// which the DOM cannot see: inside a chip that overflows, the element
		// carrying `text-overflow: ellipsis` has to be a block container.
		const api = apiClient(request, ALICE.apiKey);
		const longName = `Chip Overflowing Engineering Workflow ${runId}`;
		const long = await body<WorkflowResponse>(await api.post('/api/v1/workflows', flow(longName)));

		await signIn(context, ALICE.sessionToken);
		await page.goto(`/context?workflow=${long.id}`);
		const row = page.locator('li:not([inert])').filter({ hasText: 'instructions' });
		await expect(row).toHaveCount(1);
		const chip = row.getByTitle(`state Review (workflow \u201C${longName}\u201D)`);
		await expect(chip).toContainText(`${longName} / Review`);

		const measured = await chip.evaluate((el) => {
			const ellipsised = [el, ...el.querySelectorAll('*')]
				.filter((n): n is HTMLElement => n instanceof HTMLElement)
				.filter((n) => getComputedStyle(n).textOverflow === 'ellipsis')
				.map((n) => ({
					display: getComputedStyle(n).display,
					whiteSpace: getComputedStyle(n).whiteSpace,
					overflowX: getComputedStyle(n).overflowX,
					overflows: n.scrollWidth > n.clientWidth
				}));
			return { width: el.getBoundingClientRect().width, ellipsised };
		});

		// The name does not fit: the chip is pinned to its `max-w-56` cap.
		expect(measured.width).toBeGreaterThan(200);
		expect(measured.width).toBeLessThanOrEqual(225);
		// …and exactly the clipped element renders an ellipsis. `display` is the
		// crux: a flex item's text lives in an anonymous box that `text-overflow`
		// never reaches, so a flex value here means the glyph is cut in half.
		const clipped = measured.ellipsised.filter((n) => n.overflows);
		expect(clipped).toHaveLength(1);
		expect(clipped[0].display).toBe('block');
		expect(clipped[0].whiteSpace).toBe('nowrap');
		expect(clipped[0].overflowX).toBe('hidden');
	});

	test('on a phone the cap narrows so the item name keeps its own room', async ({
		page,
		context,
		request
	}) => {
		// The chips wrapper never shrinks below the chip's cap and `ContextItemList`
		// puts the item name and the chips on one non-wrapping row, so the cap comes
		// straight out of the name. At the wide (`sm`) cap a 390px phone left the
		// name a glyph or two, so the cap is `max-w-48 sm:max-w-56` (Tines/221
		// review). Both halves have to stay legible here — and the chip has to keep
		// truncating on a block child, i.e. the original bug stays fixed.
		const api = apiClient(request, ALICE.apiKey);
		const longName = `Chip Phone Engineering Workflow ${runId}`;
		const long = await body<WorkflowResponse>(await api.post('/api/v1/workflows', flow(longName)));

		await signIn(context, ALICE.sessionToken);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`/context?workflow=${long.id}`);
		const row = page.locator('li:not([inert])').filter({ hasText: 'instructions' });
		await expect(row).toHaveCount(1);
		const chip = row.getByTitle(`state Review (workflow \u201C${longName}\u201D)`);
		await expect(chip).toBeVisible();

		const measured = await chip.evaluate((el) => {
			const name = el.closest('li')!.querySelector<HTMLElement>('span.truncate.font-medium')!;
			const ellipsised = [el, ...el.querySelectorAll('*')]
				.filter((n): n is HTMLElement => n instanceof HTMLElement)
				.filter((n) => getComputedStyle(n).textOverflow === 'ellipsis')
				.map((n) => ({
					display: getComputedStyle(n).display,
					overflows: n.scrollWidth > n.clientWidth
				}));
			return {
				chipWidth: el.getBoundingClientRect().width,
				nameWidth: name.getBoundingClientRect().width,
				ellipsised
			};
		});

		// The chip is pinned to the narrow cap, not the `sm` one…
		expect(measured.chipWidth).toBeGreaterThan(150);
		expect(measured.chipWidth).toBeLessThanOrEqual(200);
		// …which leaves the item's own name a readable amount of room. (At the wide
		// cap this measured 13-22px on this viewport, and 0px at 375px.)
		expect(measured.nameWidth).toBeGreaterThan(30);
		// The ellipsis still renders on a block child: the fix is not viewport-bound.
		const clipped = measured.ellipsised.filter((n) => n.overflows);
		expect(clipped).toHaveLength(1);
		expect(clipped[0].display).toBe('block');
	});

	test('the workflow page keeps its own chips short', async ({ page, context }) => {
		await signIn(context, ALICE.sessionToken);
		await gotoHydrated(page, `/workflows/${eng.id}`);
		const section = page.getByRole('heading', { name: 'Context by state' }).locator('..');
		const expander = section.getByRole('button', { name: /^Review/ });
		// Same live-row scoping as above; this path has no swap, so it is consistency,
		// not a fix.
		const row = section.locator('li:not([inert])').filter({ hasText: 'instructions' });
		await expect(async () => {
			await expander.click();
			await expect(row).toBeVisible();
		}).toPass({ timeout: 15_000 });
		// The section groups by state, so the chip stays the bare state name.
		await expect(row).toContainText('Review');
		await expect(row).not.toContainText(engName);
	});
});
