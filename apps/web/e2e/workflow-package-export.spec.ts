import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	canonicalizeLibraryValue,
	parseLibraryV3Document,
	type ContextItem,
	type EffectiveContext,
	type CreateIssueResponse,
	type Project,
	type WorkflowPackageDocument,
	type WorkflowResponse
} from '@tines/shared';
import { expect, test, type Page } from '@playwright/test';
import { d1, sqlLiteral } from './d1';
import { ALICE, BASE_URL, BOB } from './constants.mjs';
import { apiClient, body, DESKTOP, gotoHydrated, PHONE, runId, signIn } from './helpers';

const name = `Browser package ${runId}`;
const dependencyName = `Browser dependency ${runId}`;
const projectName = `Browser package project ${runId}`;
const scheduleName = `Browser package schedule ${runId}`;
const literal = 'The ordinary prose marker stays exactly unchanged.';
const markdownTail = 'The final Markdown passage is visible only after expansion.';
const imageUrl = 'https://example.invalid/auto-fetch.png';
const longMarkdown = `# Long guidance

![remote pixel](${imageUrl})

${Array.from({ length: 92 }, (_, index) => `guidance${index + 1}`).join(' ')}

\`\`\`text
${Array.from({ length: 24 }, (_, index) => `fenced${index + 1}`).join(' ')}
\`\`\`

[Reviewed destination](https://example.invalid/never-fetch) ${markdownTail}`;
const longText = `alpha    beta
line two
${Array.from({ length: 125 }, (_, index) => `plain${index + 1}`).join(' ')}`;
let workflowId: string;
let sourceDependencyId: string;
let sourceConventionsId: string;
let projectId: string;
let scheduleId: string;
async function openExport(page: Page) {
	await gotoHydrated(page, `/workflows/${workflowId}/export`);
	await expect(page.getByRole('heading', { name: 'Workflow graph and gates' })).toBeVisible();
}

async function rebuildCandidate(page: Page) {
	const rebuild = page.getByRole('button', { name: 'Rebuild from source' });
	const rebuilt = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === `/api/v1/workflows/${workflowId}/export` &&
			response.request().method() === 'GET' &&
			response.ok()
	);
	await rebuild.click();
	await (await rebuilt).finished();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await expect(rebuild).toBeEnabled();
}

function candidateInputs(page: Page) {
	return page.getByRole('region', { name: '2. Candidate inputs and exact text uses' });
}

function declaredInput(page: Page, key: string) {
	return candidateInputs(page).getByRole('button', { name: new RegExp(`^${key} ·`) });
}

function inputReplacement(page: Page) {
	return candidateInputs(page).getByTestId('input-replacement');
}

async function reviewDependencies(page: Page) {
	for (const checkbox of await page
		.getByRole('checkbox', { name: /I reviewed (every file|this required repository)/ })
		.all())
		await checkbox.check();
}

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
	const api = apiClient(request, ALICE.apiKey);
	const dependency = await body<{ id: string; states: { id: string; name: string }[] }>(
		await api.post('/api/v1/workflows', {
			name: dependencyName,
			description: 'Required inherited browser evidence guidance.',
			initial_state: 'Conventions',
			states: [
				{ name: 'Conventions', category: 'active' },
				{ name: 'Complete', category: 'done' }
			],
			transitions: [{ name: 'Accept', from: 'Conventions', to: 'Complete' }]
		})
	);
	const conventions = dependency.states.find((state) => state.name === 'Conventions')!;
	sourceDependencyId = dependency.id;
	sourceConventionsId = conventions.id;
	await body(
		await api.post('/api/v1/context', {
			kind: 'prompt',
			name: 'inherited-first',
			workflow_state_id: conventions.id,
			body: 'Read this inherited dependency before the local browser instructions.'
		})
	);
	const workflow = await body<{ id: string; states: { id: string; name: string }[] }>(
		await api.post('/api/v1/workflows', {
			name,
			description: 'A browser-authored portable workflow.',
			initial_state: 'Draft',
			states: [
				{ name: 'Draft', category: 'active', inherits_from: conventions.id },
				{ name: 'Review', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				{
					name: 'Finish',
					from: 'Draft',
					to: 'Done',
					requires: [{ artifact: 'report', type: 'text', content_type: 'text/markdown' }]
				}
			]
		})
	);
	workflowId = workflow.id;
	const draft = workflow.states.find((state) => state.name === 'Draft')!;
	const review = workflow.states.find((state) => state.name === 'Review')!;
	await body(
		await api.post('/api/v1/context', {
			kind: 'prompt',
			name: 'instructions',
			workflow_state_id: draft.id,
			body: `Replace TARGET only. Another TARGET remains ordinary prose. ${literal} Literal token-like text {{not_declared:value}} also stays. Escaped literal \\{{target_name:TARGET}} stays.`
		})
	);
	await body(
		await api.post('/api/v1/context', {
			kind: 'prompt',
			name: 'long-guide',
			workflow_state_id: draft.id,
			body: longMarkdown
		})
	);
	await body(
		await api.post('/api/v1/context', {
			kind: 'skill',
			name: 'browser-check',
			workflow_state_id: draft.id,
			files: [
				{ path: 'SKILL.md', content: '# Browser check\n\nUse the exact viewport.' },
				{ path: 'notes.txt', content: longText }
			]
		})
	);
	await body(
		await api.post('/api/v1/context', {
			kind: 'skill',
			name: 'qa-handoff',
			workflow_state_id: draft.id,
			files: [
				{
					path: 'SKILL.md',
					content: '# QA handoff\n\nAttach the evidence and use the gated transition.'
				},
				{ path: 'checklist.txt', content: 'inspect\nverify\nhandoff\n' }
			]
		})
	);
	await body(
		await api.post('/api/v1/context', {
			kind: 'repo',
			name: 'source',
			workflow_state_id: draft.id,
			repo_url: 'https://github.com/tbuckley/tines',
			repo_branch: 'main',
			repo_dir: null
		})
	);
	const project = await body<Project>(
		await api.post('/api/v1/projects', { name: projectName, default_workflow_id: workflow.id })
	);
	projectId = project.id;
	const issue = await body<CreateIssueResponse>(
		await api.post(`/api/v1/projects/${projectId}/issues`, {
			title: 'Scheduled title {{count}}',
			description: '**Scheduled description** for {{schedule_name}}.',
			workflow_id: workflow.id,
			state: review.id,
			schedule: {
				name: scheduleName,
				preset: { kind: 'daily', time: '05:00' },
				timezone: 'Europe/Dublin',
				require_all_closed: true
			}
		})
	);
	scheduleId = issue.schedule!.id;
	await request.dispose();
});

test.beforeEach(async ({ context }) => signIn(context, ALICE.sessionToken));

test('authors an exact declared use and downloads the reviewed canonical package', async ({
	page,
	request
}) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	const externalRequests: string[] = [];
	page.on('request', (request) => {
		if (new URL(request.url()).origin !== BASE_URL) externalRequests.push(request.url());
	});
	await gotoHydrated(page, `/workflows/${workflowId}`);
	await page.getByRole('link', { name: 'Export package' }).click();
	await expect(page).toHaveURL(`/workflows/${workflowId}/export`);
	await expect(page.getByRole('heading', { name: 'Workflow graph and gates' })).toBeVisible();
	await expect(page.getByText('report · text · text/markdown')).toBeVisible();
	await expect(page.getByText(literal, { exact: false })).toBeVisible();
	// The acceptance file carries optional automation, but the first installation
	// intentionally omits it to prove the project-free path.
	await page.getByLabel('Source project').selectOption(projectId);
	await page.getByRole('checkbox', { name: new RegExp(scheduleName) }).check();
	await page.getByText('Tier preferences (explicit, optional)').click();
	const draftTier = page
		.locator('div.rounded-md')
		.filter({ hasText: `${name} › Draft` })
		.last();
	await draftTier.locator('select').selectOption('balanced');
	await draftTier.getByRole('checkbox', { name: 'Project-scoped' }).check();
	await page.getByRole('button', { name: 'Rebuild from source' }).click();
	await page.getByLabel('Key').fill('target_workflow');
	await page.getByLabel('Type').selectOption('workflow');
	await page.getByLabel('Default').fill('Standard');
	await page.getByRole('textbox', { name: 'Label', exact: true }).fill('Target workflow');
	await page.getByRole('button', { name: 'Add typed declaration' }).click();
	const targetWorkflow = declaredInput(page, 'target_workflow');
	await expect(targetWorkflow).toHaveAttribute('aria-pressed', 'true');
	await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(1);
	await page.getByLabel('Key').fill('target_name');
	await page.getByLabel('Type').selectOption('text');
	await page.getByLabel('Default').fill('TARGET');
	await page.getByRole('textbox', { name: 'Label', exact: true }).fill('Target name');
	await page.getByRole('button', { name: 'Add typed declaration' }).click();
	const targetName = declaredInput(page, 'target_name');
	await expect(targetWorkflow).toHaveAttribute('aria-pressed', 'false');
	await expect(targetName).toHaveAttribute('aria-pressed', 'true');
	const reviewedCheckbox = page
		.getByRole('checkbox', { name: /I reviewed (every file|this required repository)/ })
		.first();
	await reviewedCheckbox.check();
	const digestBeforeSelection = await page
		.locator('[role="status"]')
		.filter({ hasText: 'Candidate:' })
		.locator('span.break-all')
		.textContent();
	await targetWorkflow.click();
	await expect(targetWorkflow).toHaveAttribute('aria-pressed', 'true');
	await expect(targetName).toHaveAttribute('aria-pressed', 'false');
	await expect(reviewedCheckbox).toBeChecked();
	await expect(
		page.locator('[role="status"]').filter({ hasText: 'Candidate:' }).locator('span.break-all')
	).toHaveText(digestBeforeSelection!);
	await page
		.getByLabel('Exact candidate field')
		.selectOption({ label: 'instructions — prompt body' });
	const editor = page.locator('textarea');
	await editor.focus();
	await expect(inputReplacement(page)).toContainText('Using target_workflow');
	await targetName.click();
	await expect(inputReplacement(page)).toContainText('Using target_name');
	await editor.evaluate((node: HTMLTextAreaElement) => {
		const start = node.value.indexOf('TARGET');
		node.focus();
		node.setSelectionRange(start, start + 'TARGET'.length);
	});
	await page.getByRole('button', { name: 'Replace selection with declared token' }).click();
	const token = page.getByRole('button', {
		name: /Show declaration for \{\{target_name:TARGET\}\}/
	});
	await expect(token).toBeVisible();
	// The escaped literal renders as ordinary text: exactly one substitutable use.
	await expect(token).toHaveCount(1);
	await expect(page.getByText('Escaped literal {{target_name:TARGET}} stays.')).toBeVisible();
	await targetWorkflow.click();
	await expect(inputReplacement(page)).toContainText('Using target_workflow');
	await token.click();
	await expect(targetName).toHaveAttribute('aria-pressed', 'true');
	await expect(targetWorkflow).toHaveAttribute('aria-pressed', 'false');
	await expect(inputReplacement(page)).toContainText('Using target_name');
	await expect(page.getByRole('button', { name: 'Back to passage' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(token).toBeFocused();
	await reviewDependencies(page);
	await page.getByRole('button', { name: 'Save candidate text' }).click();
	await expect(page.getByRole('button', { name: 'Download package' })).toBeDisabled();
	await expect(page.getByText('Required skill and repository review was reset.')).toBeVisible();
	await reviewDependencies(page);
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Download package' }).click();
	const download = await downloadPromise;
	const path = await download.path();
	const source = await (await import('node:fs/promises')).readFile(path!, 'utf8');
	const document = (await parseLibraryV3Document(source)) as WorkflowPackageDocument;
	expect(source).toBe(`${canonicalizeLibraryValue(document)}\n`);
	expect(document.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
	expect(document.inputs.find((input) => input.key === 'target_name')?.default).toBe('TARGET');
	expect(document.text_uses).toHaveLength(1);
	const prompt = document.context.find(
		(item) => item.kind === 'prompt' && item.name === 'instructions'
	);
	expect(prompt?.kind === 'prompt' ? prompt.body : '').toContain(literal);
	expect(prompt?.kind === 'prompt' ? prompt.body : '').toContain('{{not_declared:value}}');
	expect(prompt?.kind === 'prompt' ? prompt.body : '').toContain(
		'Escaped literal \\{{target_name:TARGET}} stays.'
	);

	// Alice's exact browser download is Bob's browser input without conversion.
	const directory = mkdtempSync(join(tmpdir(), 'tines-browser-package-'));
	const packagePath = join(directory, 'package.json');
	writeFileSync(packagePath, source);
	await signIn(page.context(), BOB.sessionToken);
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	await page.getByLabel('Target workflow').selectOption({ label: 'Standard' });
	await page.getByLabel('Target name').fill('DESTINATION');
	await page.getByLabel(`Main · ${name}`).fill(`${name} installed`);
	await page.getByRole('button', { name: 'Prepare installation' }).click();
	await expect(page.getByRole('heading', { name: 'Complete installation plan' })).toBeVisible();
	await expect(page.getByText('Replace DESTINATION only.', { exact: false }).first()).toBeVisible();
	await expect(
		page.getByText('Another TARGET remains ordinary prose.', { exact: false }).first()
	).toBeVisible();
	for (const checkbox of await page.getByRole('checkbox', { name: /I reviewed/ }).all())
		await checkbox.check();
	await page.getByRole('checkbox', { name: /I confirm exact plan/ }).check();

	// The signed plan is actor-bound. A wrong-actor rejection is a definite rollback,
	// leaving the same reviewed plan available to its owner.
	await signIn(page.context(), ALICE.sessionToken);
	await page.getByRole('button', { name: 'Install package' }).click();
	await expect(page.getByText('Prepare this package again as the installing actor')).toBeVisible();
	await expect(page.locator('[data-package-receipt]')).toHaveCount(0);

	// Change Bob's destination after preparation. The backend must reject the stale
	// witness without installing, and the browser must require a fresh preview and confirmation.
	await signIn(page.context(), BOB.sessionToken);
	const bobApi = apiClient(request, BOB.apiKey);
	await body(
		await bobApi.post('/api/v1/workflows', {
			name: `${name} installed`,
			description: 'Collision created after package preparation.',
			initial_state: 'Existing',
			states: [{ name: 'Existing', category: 'active' }],
			transitions: []
		})
	);
	await page.getByRole('button', { name: 'Install package' }).click();
	await expect(page.getByText('Prepare and confirm a fresh plan.', { exact: false })).toBeVisible();
	await expect(page.locator('[data-package-receipt]')).toHaveCount(0);
	await page.getByLabel(`Main · ${name}`).fill(`${name} installed reviewed`);
	await page.getByRole('button', { name: 'Prepare installation' }).click();
	await expect(page.getByRole('heading', { name: 'Complete installation plan' })).toBeVisible();
	for (const checkbox of await page.getByRole('checkbox', { name: /I reviewed/ }).all())
		if (!(await checkbox.isChecked())) await checkbox.check();
	await expect(page.getByRole('checkbox', { name: /I confirm exact plan/ })).not.toBeChecked();
	await page.getByRole('checkbox', { name: /I confirm exact plan/ }).check();
	await page.getByRole('button', { name: 'Install package' }).click();
	await expect(page.getByRole('heading', { name: 'Package installed', exact: true })).toBeFocused();
	const installedPromptHref = await page
		.getByText('prompt · instructions', { exact: true })
		.locator('..')
		.getByRole('link')
		.getAttribute('href');
	expect(installedPromptHref).toMatch(/^\/context\?workflow=wf_/);
	const installedWorkflowHref = await page
		.getByText(`workflow · ${name} installed reviewed · main`, { exact: true })
		.locator('..')
		.getByRole('link')
		.getAttribute('href');
	expect(installedWorkflowHref).toMatch(/^\/workflows\/wf_/);
	const installedWorkflow = await body<WorkflowResponse>(
		await bobApi.get(`/api/v1${installedWorkflowHref!}`)
	);
	const installedContexts = (
		await Promise.all(
			installedWorkflow.states.map(async (state) =>
				body<{ items: ContextItem[] }>(await bobApi.get(`/api/v1/context?state=${state.id}`))
			)
		)
	).flatMap((result) => result.items);
	const copied = installedContexts.find((item) => item.name === 'instructions');
	expect(copied).toBeTruthy();
	expect(copied!.body).toContain('Replace DESTINATION only.');
	expect(copied!.body).toContain('Another TARGET remains ordinary prose.');
	expect(copied!.body).toContain(literal);
	expect(copied!.body).toContain('{{not_declared:value}}');
	expect(copied!.body).toContain('Escaped literal {{target_name:TARGET}} stays.');
	expect(copied!.body).not.toContain('DESTINATION}}');
	// Inspect the installed graph and exact gate, not merely Alice's source proof.
	const installedDraft = installedWorkflow.states.find((state) => state.name === 'Draft')!;
	const dependencyHref = await page
		.getByText(`workflow · ${dependencyName} · dependency`, { exact: true })
		.locator('..')
		.getByRole('link')
		.getAttribute('href');
	const installedDependency = await body<WorkflowResponse>(
		await bobApi.get(`/api/v1${dependencyHref}`)
	);
	const installedConventions = installedDependency.states.find(
		(state) => state.name === 'Conventions'
	)!;
	expect(installedDraft.inherits_from).toBe(installedConventions.id);
	expect(installedWorkflow.id).not.toBe(workflowId);
	expect(installedDependency.id).not.toBe(sourceDependencyId);
	expect(installedConventions.id).not.toBe(sourceConventionsId);
	const finish = installedWorkflow.transitions.find((transition) => transition.name === 'Finish')!;
	expect(finish).toMatchObject({
		from_state_id: installedDraft.id,
		to_state_id: installedWorkflow.states.find((state) => state.name === 'Done')!.id,
		requires: [{ artifact: 'report', type: 'text', content_type: 'text/markdown' }]
	});
	const copiedSkill = installedContexts.find((item) => item.name === 'browser-check')!;
	const skill = await body<ContextItem>(await bobApi.get(`/api/v1/context/${copiedSkill.id}`));
	expect(skill.files).toEqual([
		{ path: 'SKILL.md', content: '# Browser check\n\nUse the exact viewport.' },
		{ path: 'notes.txt', content: longText }
	]);
	const handoffSkill = await body<ContextItem>(
		await bobApi.get(
			`/api/v1/context/${installedContexts.find((item) => item.name === 'qa-handoff')!.id}`
		)
	);
	expect(handoffSkill.files).toEqual([
		{
			path: 'SKILL.md',
			content: '# QA handoff\n\nAttach the evidence and use the gated transition.'
		},
		{ path: 'checklist.txt', content: 'inspect\nverify\nhandoff\n' }
	]);
	const localPrompts = installedContexts
		.filter((item) => ['instructions', 'long-guide'].includes(item.name))
		.sort((a, b) => a.position - b.position);
	expect(localPrompts.map((item) => item.name)).toEqual(['instructions', 'long-guide']);
	expect(localPrompts[0].position).toBeLessThan(localPrompts[1].position);
	// First prove install created no issues/schedules. Only then explicitly create an
	// inspection issue, so the ordinary effective-context API can assemble inheritance.
	const workflowIds = [installedWorkflow.id, installedDependency.id].map(sqlLiteral).join(',');
	expect(d1(`SELECT id FROM issue WHERE workflow_id IN (${workflowIds})`)).toEqual([]);
	expect(d1(`SELECT id FROM scheduled_task WHERE workflow_id IN (${workflowIds})`)).toEqual([]);
	const inspectionProject = await body<Project>(
		await bobApi.post('/api/v1/projects', { name: `Installed context inspection ${runId}` })
	);
	const inspectionIssue = await body<CreateIssueResponse>(
		await bobApi.post(`/api/v1/projects/${inspectionProject.id}/issues`, {
			title: 'Explicit context inspection',
			workflow_id: installedWorkflow.id,
			state: installedDraft.id
		})
	);
	const effective = await body<EffectiveContext>(
		await bobApi.get(`/api/v1/issues/${inspectionIssue.id}/context`)
	);
	const parts = effective.prompt.parts.filter((part) =>
		['inherited-first', 'instructions', 'long-guide'].includes(part.name)
	);
	expect(parts.map((part) => part.name)).toEqual(['inherited-first', 'instructions', 'long-guide']);
	expect(parts[0]).toMatchObject({
		body: 'Read this inherited dependency before the local browser instructions.',
		inherited_from: { state_id: installedConventions.id, workflow_id: installedDependency.id }
	});
	expect(parts[1].body).toBe(copied!.body);
	expect(parts[2].body).toBe(longMarkdown);
	expect(effective.skills.find((item) => item.name === 'browser-check')?.files).toEqual(
		skill.files
	);
	expect(effective.repos.find((item) => item.name === 'source')).toMatchObject({
		url: 'https://github.com/tbuckley/tines',
		branch: 'main'
	});

	// The same reviewed file can create a second independent copy with its
	// optional schedule and tier enabled for exactly one destination project.
	const secondProject = await body<Project>(
		await bobApi.post('/api/v1/projects', { name: `Installed context second ${runId}` })
	);
	const secondInspectionIssue = await body<CreateIssueResponse>(
		await bobApi.post(`/api/v1/projects/${secondProject.id}/issues`, {
			title: 'Second-project context inspection',
			workflow_id: installedWorkflow.id,
			state: installedDraft.id
		})
	);
	const secondEffective = await body<EffectiveContext>(
		await bobApi.get(`/api/v1/issues/${secondInspectionIssue.id}/context`)
	);
	expect(
		secondEffective.prompt.parts
			.filter((part) => ['inherited-first', 'instructions', 'long-guide'].includes(part.name))
			.map((part) => part.name)
	).toEqual(['inherited-first', 'instructions', 'long-guide']);
	expect(secondEffective.skills.find((item) => item.name === 'browser-check')?.files).toEqual(
		skill.files
	);
	const defaultsBefore = [inspectionProject, secondProject].map((project) => ({
		id: project.id,
		default_workflow_id: project.default_workflow_id
	}));
	const runnerId = `rnr_package_acceptance_${runId}`;
	const routingId = `rrl_package_acceptance_${runId}`;
	const now = Date.now();
	d1(`INSERT INTO runner(id,user_id,type,name,status,max_concurrent,max_run_minutes,default_tier,config,created_at,updated_at)
		VALUES(${sqlLiteral(runnerId)},${sqlLiteral(BOB.id)},'local',${sqlLiteral(`Package acceptance ${runId}`)},'active',1,30,'balanced','{"harness":"codex"}',${now},${now});
		INSERT INTO routing_rule(id,user_id,project_id,workflow_state_id,label_id,targets,created_at,updated_at)
		VALUES(${sqlLiteral(routingId)},${sqlLiteral(BOB.id)},${sqlLiteral(inspectionProject.id)},NULL,NULL,${sqlLiteral(JSON.stringify([{ runner_id: runnerId }]))},${now},${now})`);
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	await page.getByLabel('Target workflow').selectOption({ label: 'Standard' });
	await page.getByLabel('Destination project').selectOption(inspectionProject.id);
	await page
		.getByRole('group', { name: 'Optional paused schedules' })
		.getByRole('checkbox', { name: scheduleName })
		.check();
	await page
		.getByRole('group', { name: 'Optional destination tier preferences' })
		.locator('select')
		.selectOption('balanced');
	await page.getByLabel(`Main · ${name}`).fill(`${name} scheduled copy`);
	await page.getByLabel(`Dependency · ${dependencyName}`).fill(`${dependencyName} scheduled copy`);
	await page.getByRole('button', { name: 'Prepare installation' }).click();
	await expect(page.getByText('balanced for Draft in destination project')).toBeVisible();
	for (const checkbox of await page.getByRole('checkbox', { name: /I reviewed/ }).all())
		await checkbox.check();
	await page.getByRole('checkbox', { name: /I confirm exact plan/ }).check();
	const installResponse = page.waitForResponse(
		(response) => response.url().endsWith('/api/v1/library/install') && response.ok()
	);
	await page.getByRole('button', { name: 'Install package' }).click();
	const secondReceipt = (await (await installResponse).json()) as {
		objects: Array<{ kind: string; relationship?: string; id: string }>;
		reused_inputs: Array<{ input_id: string; type: string; name: string }>;
	};
	expect(secondReceipt.reused_inputs).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: 'workflow', name: 'Standard' }),
			expect.objectContaining({ type: 'project', name: inspectionProject.name })
		])
	);
	const secondMainId = secondReceipt.objects.find(
		(object) => object.kind === 'workflow' && object.relationship === 'main'
	)!.id;
	const secondDependencyId = secondReceipt.objects.find(
		(object) => object.kind === 'workflow' && object.relationship === 'dependency'
	)!.id;
	const installedScheduleId = secondReceipt.objects.find(
		(object) => object.kind === 'schedule'
	)!.id;
	expect(
		d1(
			`SELECT enabled,last_run_at,run_count,project_id FROM scheduled_task WHERE id=${sqlLiteral(installedScheduleId)}`
		)
	).toEqual([{ enabled: 0, last_run_at: null, run_count: 0, project_id: inspectionProject.id }]);
	expect(d1(`SELECT id FROM issue WHERE workflow_id=${sqlLiteral(secondMainId)}`)).toEqual([]);
	for (const before of defaultsBefore) {
		expect(d1(`SELECT default_workflow_id FROM project WHERE id=${sqlLiteral(before.id)}`)).toEqual(
			[{ default_workflow_id: before.default_workflow_id }]
		);
	}

	// Ordinary editing of one copied dependency cannot mutate Alice's source or
	// the other installed copy.
	await body(
		await bobApi.patch(`/api/v1/workflows/${installedDependency.id}`, {
			description: 'Edited only in the first independent copy.'
		})
	);
	expect(
		(await body<WorkflowResponse>(await bobApi.get(`/api/v1/workflows/${installedDependency.id}`)))
			.description
	).toBe('Edited only in the first independent copy.');
	expect(
		(await body<WorkflowResponse>(await bobApi.get(`/api/v1/workflows/${secondDependencyId}`)))
			.description
	).toBe('Required inherited browser evidence guidance.');
	const aliceApi = apiClient(request, ALICE.apiKey);
	expect(
		(await body<WorkflowResponse>(await aliceApi.get(`/api/v1/workflows/${sourceDependencyId}`)))
			.description
	).toBe('Required inherited browser evidence guidance.');
	// Ordinary receipt links remain navigable after the read-back inspection.
	expect((await bobApi.get(`/api/v1/context/${copiedSkill.id}`)).ok()).toBe(true);
	expect(externalRequests).toEqual([]);
	await page.evaluate(() => globalThis.scrollTo(0, 0));
	await page.screenshot({
		path: test.info().outputPath('workflow-package-desktop.png'),
		fullPage: true
	});
	await page.setViewportSize(PHONE);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const overflow = await page.evaluate(() =>
		[...globalThis.document.querySelectorAll<HTMLElement>('*')]
			.filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
			.map((element) => `${element.tagName}.${element.className}`)
	);
	expect(overflow).toEqual([]);
	await page.evaluate(() => globalThis.scrollTo(0, 0));
	await page.screenshot({
		path: test.info().outputPath('workflow-package-phone.png'),
		fullPage: true
	});
});

test('reviews inheritance plus long Markdown and plain-text files without remote loads', async ({
	page
}) => {
	await page.setViewportSize(DESKTOP);
	const externalRequests: string[] = [];
	page.on('request', (request) => {
		if (new URL(request.url()).host === 'example.invalid') externalRequests.push(request.url());
	});
	await openExport(page);
	await expect(page.getByText('Required inheritance dependency')).toBeVisible();
	await expect(page.getByRole('heading', { name: `${name} › Draft` })).toBeVisible();
	await expect(
		page.getByRole('heading', { name: `${dependencyName} › Conventions` })
	).toBeVisible();
	await expect(page.getByText('Read this inherited dependency before')).toBeVisible();

	const markdownSection = page
		.getByRole('heading', { name: /^long-guide/ })
		.locator('..')
		.locator('..');
	await expect(markdownSection.getByRole('heading', { name: 'Long guidance' })).toBeVisible();
	await expect(markdownSection.locator('img')).toHaveCount(0);
	await expect(
		markdownSection.getByRole('img', { name: `Image not loaded: remote pixel — ${imageUrl}` })
	).toHaveText(`Image (not loaded): remote pixel — ${imageUrl}`);
	await expect(markdownSection.getByText(markdownTail)).toBeHidden();
	await expect(markdownSection.locator('pre code')).toContainText('fenced24');
	const expandMarkdown = markdownSection.getByRole('button', { name: /Show all \d+ words/ });
	await expandMarkdown.click();
	await expect(page.getByText(markdownTail)).toBeVisible();
	const collapseMarkdown = markdownSection.getByRole('button', { name: 'Show snippet' });
	await expect(collapseMarkdown).toBeFocused();
	await expect(markdownSection.getByRole('link', { name: 'Reviewed destination' })).toHaveAttribute(
		'href',
		'https://example.invalid/never-fetch'
	);
	await collapseMarkdown.click();
	await expect(page.getByText(markdownTail)).toBeHidden();
	await expect(markdownSection.getByRole('button', { name: /Show all \d+ words/ })).toBeFocused();

	const plainBlock = page.getByText('notes.txt').locator('..').locator('..');
	await expect(plainBlock.locator('pre')).toContainText('alpha    beta\nline two');
	const expandText = plainBlock.getByRole('button', { name: /Show all \d+ words/ });
	await expandText.click();
	await expect(plainBlock.locator('pre')).toContainText('plain125');
	const collapseText = plainBlock.getByRole('button', { name: 'Show snippet' });
	await expect(collapseText).toBeFocused();
	await collapseText.click();
	await expect(plainBlock.locator('pre')).not.toContainText('plain125');
	await expect(plainBlock.getByRole('button', { name: /Show all \d+ words/ })).toBeFocused();
	await expect.poll(() => externalRequests).toEqual([]);
});

test('reviews optional schedule and tier configuration and repairs project scope at None', async ({
	page
}) => {
	await openExport(page);
	await page.getByLabel('Source project').selectOption(projectId);
	const schedule = page.locator('label').filter({ hasText: scheduleName });
	await expect(schedule).toContainText(name);
	await expect(schedule).toContainText('Explicit: Review');
	await expect(schedule).toContainText('Europe/Dublin');
	await expect(schedule).toContainText('Require all prior scheduled issues closed');
	await expect(schedule).toContainText('Scheduled title {{count}}');
	await expect(schedule).toContainText('**Scheduled description**');
	await expect(page.getByText(workflowId, { exact: true })).toHaveCount(0);
	await expect(page.getByText(scheduleId, { exact: true })).toHaveCount(0);

	await page.getByText('Tier preferences (explicit, optional)').click();
	const draftTier = page
		.locator('div.rounded-md')
		.filter({ hasText: `${name} › Draft` })
		.last();
	await draftTier.locator('select').selectOption('balanced');
	await draftTier.getByRole('checkbox', { name: 'Project-scoped' }).check();
	await page.getByLabel('Source project').selectOption('');
	await expect(draftTier.getByRole('checkbox', { name: 'Project-scoped' })).not.toBeChecked();
	await page.getByRole('button', { name: 'Rebuild from source' }).click();
	await expect(page.getByText('Balanced for Draft without a project')).toBeVisible();

	await page.getByLabel('Source project').selectOption(projectId);
	await page.getByRole('checkbox', { name: new RegExp(scheduleName) }).check();
	await draftTier.getByRole('checkbox', { name: 'Project-scoped' }).check();
	await page.getByRole('button', { name: 'Rebuild from source' }).click();
	const proof = page.locator(`#review-schedule\\:1`);
	await expect(proof).toContainText(scheduleName);
	await expect(proof).toContainText(`workflow:1`);
	await expect(proof).toContainText('Explicit: Review');
	await expect(proof).toContainText('Require every prior scheduled issue to be closed');
	await expect(proof).toContainText('Scheduled title {{count}}');
	await expect(proof).toContainText('Scheduled description');
	await expect(page.getByText('Balanced for Draft in destination project')).toBeVisible();
	await expect(page.getByText(scheduleId)).toHaveCount(0);
});

test('does not restore a stale generated input selection when its ID returns', async ({ page }) => {
	await openExport(page);
	await page.getByLabel('Source project').selectOption(projectId);
	const schedule = page.getByRole('checkbox', { name: new RegExp(scheduleName) });
	await schedule.check();
	await rebuildCandidate(page);
	const destination = declaredInput(page, 'destination_project');
	await destination.click();
	await expect(destination).toHaveAttribute('aria-pressed', 'true');
	await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(1);
	await page
		.getByLabel('Exact candidate field')
		.selectOption({ label: 'instructions — prompt body' });
	const replace = page.getByRole('button', { name: 'Replace selection with declared token' });
	await expect(replace).toBeEnabled();
	await expect(inputReplacement(page)).toContainText('Using destination_project');

	await schedule.uncheck();
	await rebuildCandidate(page);
	await expect(destination).toHaveCount(0);
	await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(0);
	await expect(inputReplacement(page)).not.toContainText('Using');
	await expect(replace).toBeDisabled();

	await schedule.check();
	await rebuildCandidate(page);
	await expect(destination).toHaveAttribute('aria-pressed', 'false');
	await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(0);
	await expect(inputReplacement(page)).not.toContainText('Using');
	await expect(replace).toBeDisabled();
});

test('retains a generated input selection across an equivalent rebuild', async ({ page }) => {
	await openExport(page);
	await page.getByLabel('Source project').selectOption(projectId);
	await page.getByRole('checkbox', { name: new RegExp(scheduleName) }).check();
	await rebuildCandidate(page);
	const destination = declaredInput(page, 'destination_project');
	await expect(destination).toHaveAttribute('aria-pressed', 'false');
	await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(0);
	await page
		.getByLabel('Exact candidate field')
		.selectOption({ label: 'instructions — prompt body' });
	await expect(
		page.getByRole('button', { name: 'Replace selection with declared token' })
	).toBeDisabled();
	await expect(inputReplacement(page)).not.toContainText('Using');

	await destination.click();
	await expect(destination).toHaveAttribute('aria-pressed', 'true');
	await expect(inputReplacement(page)).toContainText('Using destination_project');
	await rebuildCandidate(page);
	await expect(destination).toHaveAttribute('aria-pressed', 'true');
	await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(1);
	await expect(inputReplacement(page)).toContainText('Using destination_project');
});

for (const theme of ['light', 'dark'] as const) {
	for (const viewport of [DESKTOP, PHONE]) {
		test(`keeps declared input selection visible at ${viewport.width}px in ${theme} mode`, async ({
			page
		}, testInfo) => {
			await page.setViewportSize(viewport);
			await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
			await page.goto('/');
			await page.evaluate((savedTheme) => {
				localStorage.setItem('tines:theme', savedTheme);
			}, theme);
			await openExport(page);
			await expect(page.locator('html')).toHaveClass(
				theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/
			);
			const longKey = `project_${'n'.repeat(56)}`;
			await page.getByLabel('Key').fill(longKey);
			await page.getByRole('button', { name: 'Add typed declaration' }).click();
			await page.getByLabel('Key').fill('review_label');
			await page.getByLabel('Type').selectOption('label');
			await page.getByRole('button', { name: 'Add typed declaration' }).click();
			const longInput = declaredInput(page, longKey);
			const reviewLabel = declaredInput(page, 'review_label');

			await page.getByRole('button', { name: 'Add typed declaration' }).focus();
			await page.keyboard.press('Tab');
			await expect(longInput).toBeFocused();
			await expect(longInput).toHaveAttribute('aria-pressed', 'false');
			await expect(reviewLabel).toHaveAttribute('aria-pressed', 'true');
			const focusShadow = await longInput.evaluate(
				(element) => getComputedStyle(element).boxShadow
			);
			expect(focusShadow).not.toBe('none');
			await page.keyboard.press('Enter');
			await expect(longInput).toHaveAttribute('aria-pressed', 'true');
			await page
				.getByLabel('Exact candidate field')
				.selectOption({ label: 'instructions — prompt body' });
			const editor = candidateInputs(page).locator('textarea');
			await editor.focus();
			await expect(inputReplacement(page)).toContainText(`Using ${longKey}`);
			const selectedColors = await longInput.evaluate((element) => {
				const style = getComputedStyle(element);
				return { border: style.borderColor, background: style.backgroundColor };
			});
			const unselectedColors = await reviewLabel.evaluate((element) => {
				const style = getComputedStyle(element);
				return { border: style.borderColor, background: style.backgroundColor };
			});
			expect(selectedColors).not.toEqual(unselectedColors);
			await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(1);
			await page.screenshot({
				path: testInfo.outputPath(`package-input-first-${theme}-${viewport.width}.png`),
				fullPage: true
			});

			await longInput.focus();
			await page.keyboard.press('Tab');
			await expect(reviewLabel).toBeFocused();
			await page.keyboard.press('Space');
			await expect(reviewLabel).toHaveAttribute('aria-pressed', 'true');
			await editor.focus();
			await expect(inputReplacement(page)).toContainText('Using review_label');
			await page.screenshot({
				path: testInfo.outputPath(`package-input-second-${theme}-${viewport.width}.png`),
				fullPage: true
			});

			await longInput.click();
			await inputReplacement(page).scrollIntoViewIfNeeded();
			await expect(inputReplacement(page)).toContainText(`Using ${longKey}`);
			const geometry = await page.evaluate(() => {
				const longCard = document
					.querySelector<HTMLElement>('section[aria-labelledby="inputs-title"]')!
					.querySelector<HTMLElement>('[aria-pressed="true"]')!;
				const action = document.querySelector<HTMLElement>('[data-testid="input-replacement"]')!;
				return {
					documentOverflow:
						document.documentElement.scrollWidth - document.documentElement.clientWidth,
					cardOverflow: longCard.scrollWidth - longCard.clientWidth,
					actionOverflow: action.scrollWidth - action.clientWidth,
					cardBottom: longCard.getBoundingClientRect().bottom,
					actionTop: action.getBoundingClientRect().top,
					textOverflow: getComputedStyle(longCard.querySelector('code')!).textOverflow
				};
			});
			expect(geometry.documentOverflow).toBe(0);
			expect(geometry.cardOverflow).toBeLessThanOrEqual(1);
			expect(geometry.actionOverflow).toBeLessThanOrEqual(1);
			expect(geometry.textOverflow).not.toBe('ellipsis');
			if (viewport.width === PHONE.width)
				expect(geometry.cardBottom).toBeLessThan(geometry.actionTop);
		});
	}
}

test('discards a delayed validation result when candidate review changes', async ({ page }) => {
	await openExport(page);
	await reviewDependencies(page);
	let releaseValidation!: () => void;
	const held = new Promise<void>((resolve) => (releaseValidation = resolve));
	await page.route('**/api/v1/library/validate', async (route) => {
		const response = await route.fetch();
		await held;
		await route.fulfill({ response });
	});
	let downloads = 0;
	page.on('download', () => (downloads += 1));
	const finished = page.waitForEvent('requestfinished', {
		predicate: (request) => new URL(request.url()).pathname === '/api/v1/library/validate'
	});
	const downloadAttempt = page.getByRole('button', { name: 'Download package' }).click();
	await expect(page.getByRole('button', { name: 'Validate', exact: true })).toBeDisabled();
	await page.getByLabel('Key').fill('race_key');
	await page.getByRole('button', { name: 'Add typed declaration' }).click();
	await expect(page.getByText('Required skill and repository review was reset.')).toBeVisible();
	releaseValidation();
	await finished;
	await downloadAttempt;
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
	expect(downloads).toBe(0);
	await expect(page.getByText('The older result was discarded.')).toBeVisible();
	await expect(page.getByRole('button', { name: /race_key · text/ })).toBeVisible();
});

test('focuses validation errors and keeps the mobile action above navigation', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await openExport(page);
	await page.route('**/api/v1/library/validate', async (route) => {
		const payload = route.request().postDataJSON() as { document_json: string };
		const invalid = JSON.parse(payload.document_json) as Omit<WorkflowPackageDocument, 'digest'> & {
			digest?: string;
		};
		invalid.workflows[0].description = 'x'.repeat(10_001);
		delete invalid.digest;
		await route.continue({
			headers: { ...route.request().headers(), 'content-type': 'application/json' },
			postData: JSON.stringify({ document_json: canonicalizeLibraryValue(invalid) })
		});
	});
	await page.getByRole('button', { name: 'Validate', exact: true }).click();
	const errors = page.getByRole('alert');
	await expect(errors).toBeFocused();
	const repair = errors.getByRole('button', { name: `Repair ${name} — description` });
	await repair.click();
	await expect(page.locator('textarea')).toBeFocused();

	await page.getByRole('button', { name: 'Download package' }).scrollIntoViewIfNeeded();
	const action = await page.getByRole('button', { name: 'Download package' }).boundingBox();
	const actionBar = await page.getByTestId('package-actions').boundingBox();
	const navigation = await page.getByRole('navigation', { name: 'Primary' }).boundingBox();
	expect(action).not.toBeNull();
	expect(actionBar).not.toBeNull();
	expect(navigation).not.toBeNull();
	expect(action!.y + action!.height).toBeLessThanOrEqual(navigation!.y);
	expect(actionBar!.height).toBeLessThanOrEqual(48);
	const overflow = await page.evaluate(() =>
		[...globalThis.document.querySelectorAll<HTMLElement>('*')]
			.filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
			.map((element) => `${element.tagName}.${element.className}`)
	);
	expect(overflow).toEqual([]);
});
