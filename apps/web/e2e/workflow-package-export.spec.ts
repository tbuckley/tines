import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	canonicalizeLibraryValue,
	parseLibraryV3Document,
	type ContextItem,
	type PrepareWorkflowPackageResponse,
	type WorkflowPackageDocument
} from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, BASE_URL, BOB } from './constants.mjs';
import { apiClient, body, DESKTOP, gotoHydrated, PHONE, runId, signIn } from './helpers';

const name = `Browser package ${runId}`;
const literal = 'The ordinary prose marker stays exactly unchanged.';
let workflowId: string;
const CLI_DIR = fileURLToPath(new URL('../../../packages/cli', import.meta.url));
const TSX = join(CLI_DIR, 'node_modules', '.bin', 'tsx');
const CLI = join(CLI_DIR, 'src', 'index.ts');

function cli(args: string[]): string {
	return execFileSync(TSX, [CLI, ...args, '--url', BASE_URL, '--api-key', BOB.apiKey], {
		encoding: 'utf8',
		env: { ...process.env, TINES_API_URL: 'https://ambient-must-not-be-used.invalid' }
	});
}

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
	const api = apiClient(request, ALICE.apiKey);
	const workflow = await body<{ id: string; states: { id: string; name: string }[] }>(
		await api.post('/api/v1/workflows', {
			name,
			description: 'A browser-authored portable workflow.',
			initial_state: 'Draft',
			states: [
				{ name: 'Draft', category: 'active' },
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
	await body(
		await api.post('/api/v1/context', {
			kind: 'prompt',
			name: 'instructions',
			workflow_state_id: draft.id,
			body: `Replace TARGET only. ${literal} Literal token-like text {{not_declared:value}} also stays.`
		})
	);
	await body(
		await api.post('/api/v1/context', {
			kind: 'skill',
			name: 'browser-check',
			workflow_state_id: draft.id,
			files: [{ path: 'SKILL.md', content: '# Browser check\n\nUse the exact viewport.' }]
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
	await page.getByLabel('I reviewed every file in this required skill').check();
	await page.getByLabel('I reviewed this required repository declaration').check();
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
		JSON.stringify({ workflow_names: { [document.main_workflow_id]: `${name} installed` } })
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
	expect(copied.body).toContain('Replace TARGET only.');
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
