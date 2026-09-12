import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	canonicalizeLibraryValue,
	parseLibraryV3Document,
	type ContextItem,
	type CreateIssueResponse,
	type PrepareWorkflowPackageResponse,
	type Project,
	type WorkflowPackageDocument
} from '@tines/shared';
import { expect, test, type Page } from '@playwright/test';
import { ALICE, BASE_URL, BOB } from './constants.mjs';
import { apiClient, body, DESKTOP, gotoHydrated, PHONE, runId, signIn } from './helpers';

const name = `Browser package ${runId}`;
const dependencyName = `Browser dependency ${runId}`;
const projectName = `Browser package project ${runId}`;
const scheduleName = `Browser package schedule ${runId}`;
const literal = 'The ordinary prose marker stays exactly unchanged.';
const markdownTail = 'The final Markdown passage is visible only after expansion.';
const longMarkdown = `# Long guidance

${Array.from({ length: 92 }, (_, index) => `guidance${index + 1}`).join(' ')}

\`\`\`text
${Array.from({ length: 24 }, (_, index) => `fenced${index + 1}`).join(' ')}
\`\`\`

[Reviewed destination](https://example.invalid/never-fetch) ${markdownTail}`;
const longText = `alpha    beta
line two
${Array.from({ length: 125 }, (_, index) => `plain${index + 1}`).join(' ')}`;
let workflowId: string;
let projectId: string;
let scheduleId: string;
const CLI_DIR = fileURLToPath(new URL('../../../packages/cli', import.meta.url));
const TSX = join(CLI_DIR, 'node_modules', '.bin', 'tsx');
const CLI = join(CLI_DIR, 'src', 'index.ts');

function cli(args: string[]): string {
	return execFileSync(TSX, [CLI, ...args, '--url', BASE_URL, '--api-key', BOB.apiKey], {
		encoding: 'utf8',
		env: { ...process.env, TINES_API_URL: 'https://ambient-must-not-be-used.invalid' }
	});
}

async function openExport(page: Page) {
	await gotoHydrated(page, `/workflows/${workflowId}/export`);
	await expect(page.getByRole('heading', { name: 'Workflow graph and gates' })).toBeVisible();
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
			body: `Replace TARGET only. Another TARGET remains ordinary prose. ${literal} Literal token-like text {{not_declared:value}} also stays.`
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
	await page.setViewportSize(DESKTOP);
	const external = new URL('https://github.com/tbuckley/tines').host;
	const externalRequests: string[] = [];
	page.on('request', (request) => {
		if (new URL(request.url()).host === external) externalRequests.push(request.url());
	});
	await gotoHydrated(page, `/workflows/${workflowId}`);
	await page.getByRole('link', { name: 'Export package' }).click();
	await expect(page).toHaveURL(`/workflows/${workflowId}/export`);
	await expect(page.getByRole('heading', { name: 'Workflow graph and gates' })).toBeVisible();
	await expect(page.getByText('report · text · text/markdown')).toBeVisible();
	await expect(page.getByText(literal, { exact: false })).toBeVisible();
	await page.getByLabel('Key').fill('target_name');
	await page.getByLabel('Default').fill('TARGET');
	await page.getByRole('textbox', { name: 'Label', exact: true }).fill('Target name');
	await page.getByRole('button', { name: 'Add typed declaration' }).click();
	await page
		.getByLabel('Exact candidate field')
		.selectOption({ label: 'instructions — prompt body' });
	const editor = page.locator('textarea');
	await editor.evaluate((node: HTMLTextAreaElement) => {
		const start = node.value.indexOf('TARGET');
		node.focus();
		node.setSelectionRange(start, start + 'TARGET'.length);
	});
	await page.getByRole('button', { name: 'Replace selection with declared token' }).click();
	await expect(
		page.getByRole('button', { name: /Show declaration for \{\{target_name:TARGET\}\}/ })
	).toBeVisible();
	const token = page.getByRole('button', {
		name: /Show declaration for \{\{target_name:TARGET\}\}/
	});
	await token.click();
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

	// The browser download is the CLI's input without conversion. Install it into
	// the independent Bob account and inspect the copied prompt, proving that only
	// the declared exact use is resolved.
	const directory = mkdtempSync(join(tmpdir(), 'tines-browser-package-'));
	const packagePath = join(directory, 'package.json');
	const choicesPath = join(directory, 'choices.json');
	const planPath = join(directory, 'plan.json');
	writeFileSync(packagePath, source);
	writeFileSync(
		choicesPath,
		JSON.stringify({
			workflow_names: { [document.main_workflow_id]: `${name} installed` },
			inputs: {
				[document.inputs.find((input) => input.key === 'target_name')!.id]: {
					value: 'DESTINATION'
				}
			}
		})
	);
	const plan = JSON.parse(
		cli([
			'workflows',
			'preview',
			packagePath,
			'--choices',
			choicesPath,
			'--plan-out',
			planPath,
			'--json'
		])
	) as PrepareWorkflowPackageResponse;
	cli([
		'workflows',
		'install',
		packagePath,
		'--plan',
		planPath,
		'--confirm',
		plan.plan_digest,
		'--json'
	]);
	const installedPrompt = plan.operations.find(
		(operation) => operation.kind === 'prompt' && operation.name === 'instructions'
	);
	expect(installedPrompt?.id).toBeTruthy();
	const copied = await body<ContextItem>(
		await apiClient(request, BOB.apiKey).get(`/api/v1/context/${installedPrompt!.id}`)
	);
	expect(copied.body).toContain('Replace DESTINATION only.');
	expect(copied.body).toContain('Another TARGET remains ordinary prose.');
	expect(copied.body).toContain(literal);
	expect(copied.body).toContain('{{not_declared:value}}');
	expect(externalRequests).toEqual([]);
	await page.screenshot({
		path: test.info().outputPath('workflow-package-desktop.png'),
		fullPage: true
	});
	await page.setViewportSize(PHONE);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const overflow = await page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>('*')]
			.filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
			.map((element) => `${element.tagName}.${element.className}`)
	);
	expect(overflow).toEqual([]);
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
	const navigation = await page.getByRole('navigation', { name: 'Primary' }).boundingBox();
	expect(action).not.toBeNull();
	expect(navigation).not.toBeNull();
	expect(action!.y + action!.height).toBeLessThanOrEqual(navigation!.y);
	const overflow = await page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>('*')]
			.filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
			.map((element) => `${element.tagName}.${element.className}`)
	);
	expect(overflow).toEqual([]);
});
