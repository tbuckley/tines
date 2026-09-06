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
import { ALICE, BOB } from './constants.mjs';
import { apiClient, body, errorBody, runId, signIn } from './helpers';

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
		expect(issue.context_summary).toEqual({ prompts: 1, skills: 1, repos: 0, artifacts: 0 });
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

	test('the launch prompt is id-free with the journal as its one write affordance', async ({
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
		expect(prompt.text).toContain(`Attached to this issue: skill "sk-${runId}" (1 file)`);
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
		await page.goto(`/context?workflow=${eng.id}`);
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

	test('the workflow page keeps its own chips short', async ({ page, context }) => {
		await signIn(context, ALICE.sessionToken);
		await page.goto(`/workflows/${eng.id}`);
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
