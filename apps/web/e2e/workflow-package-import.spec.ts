import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Project,
	type ValidateLibraryResponse,
	type WorkflowPackageDocument
} from '@tines/shared';
import { automatedPackage } from '../../../packages/shared/src/library/fixtures.js';
import { expect, test } from '@playwright/test';
import { BOB } from './constants.mjs';
import { apiClient, body, DESKTOP, gotoHydrated, PHONE, runId, signIn } from './helpers';

const suffix = ` browser import ${runId}`;
let packagePath: string;
let missingWorkflowPath: string;
let mainName: string;
let dependencyName: string;
let projects: Project[];

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
	const api = apiClient(request, BOB.apiKey);
	const candidate = automatedPackage();
	(candidate as { digest?: string }).digest = undefined;
	mainName = `Reviewer${suffix}`;
	dependencyName = `Shared${suffix}`;
	candidate.workflows[0].name = mainName;
	candidate.workflows[1].name = dependencyName;
	candidate.inputs[0].default = `import-label-${runId}`;
	for (const use of candidate.text_uses) {
		use.token = `{{filing_label:import-label-${runId}}}`;
	}
	candidate.workflows[0].description = `Review {{filing_label:import-label-${runId}}} work`;
	const prompt = candidate.context.find((item) => item.kind === 'prompt')!;
	if (prompt.kind === 'prompt')
		prompt.body = `File work with label {{filing_label:import-label-${runId}}}. Preserve {{date}}.`;

	for (const workflow of candidate.workflows)
		await body(
			await api.post('/api/v1/workflows', {
				name: workflow.name,
				description: 'Collision proving independent copy names.',
				initial_state: 'Existing',
				states: [{ name: 'Existing', category: 'active' }],
				transitions: []
			})
		);
	await body(
		await api.post('/api/v1/labels', { name: candidate.inputs[0].default, color: 'blue' })
	);
	projects = await Promise.all(
		['one', 'two'].map(async (part) =>
			body<Project>(
				await api.post('/api/v1/projects', { name: `Import destination ${part} ${runId}` })
			)
		)
	);
	const validation = await body<ValidateLibraryResponse>(
		await api.post('/api/v1/library/validate', { document_json: JSON.stringify(candidate) })
	);
	expect(validation.valid).toBe(true);
	const document = validation.document as WorkflowPackageDocument;
	packagePath = join(mkdtempSync(join(tmpdir(), 'tines-browser-import-')), 'package.json');
	writeFileSync(packagePath, JSON.stringify(document));
	const missingWorkflow = automatedPackage();
	(missingWorkflow as { digest?: string }).digest = undefined;
	missingWorkflow.inputs.push({
		id: 'input:destination-workflow',
		key: 'destination_workflow',
		type: 'workflow',
		label: 'Destination workflow',
		description: 'Must provide the required destination states.',
		required: true,
		default: null,
		required_states: ['Ready']
	});
	const missingValidation = await body<ValidateLibraryResponse>(
		await api.post('/api/v1/library/validate', { document_json: JSON.stringify(missingWorkflow) })
	);
	expect(missingValidation.valid).toBe(true);
	missingWorkflowPath = join(
		mkdtempSync(join(tmpdir(), 'tines-missing-workflow-')),
		'package.json'
	);
	writeFileSync(missingWorkflowPath, JSON.stringify(missingValidation.document));
	await request.dispose();
});

test.beforeEach(async ({ context }) => signIn(context, BOB.sessionToken));

test('reviews, confirms and installs an independent project-free package through the real backend', async ({
	page,
	request
}) => {
	await page.setViewportSize(DESKTOP);
	await gotoHydrated(page, '/workflows');
	await expect(page.getByRole('link', { name: 'Install package' })).toHaveAttribute(
		'href',
		'/workflows/import'
	);
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	await expect(page.getByRole('heading', { name: 'Destination values' })).toBeVisible();
	for (const schedule of await page
		.getByRole('group', { name: 'Optional paused schedules' })
		.getByRole('checkbox')
		.all())
		await expect(schedule).not.toBeChecked();
	await expect(page.getByLabel('Destination project')).toHaveValue('');

	await page.getByRole('button', { name: 'Prepare installation' }).click();
	await expect(page.getByRole('heading', { name: 'Complete installation plan' })).toBeVisible();
	await expect(
		page.getByRole('heading', { name: `${mainName} (imported)`, exact: true })
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: `${dependencyName} (imported)`, exact: true })
	).toBeVisible();
	await expect(page.getByText('Exact declared substitutions')).toBeVisible();
	await expect(page.getByText('Original', { exact: true }).first()).toBeVisible();
	await expect(page.getByText('Installed value', { exact: true }).first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Edit candidate text' })).toHaveCount(0);
	const exactUse = page
		.getByRole('button', { name: /Show destination input for exact use/ })
		.first();
	await exactUse.click();
	await expect(page.getByRole('button', { name: 'Back to exact use' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(exactUse).toBeFocused();

	const installRequests: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'POST' && request.url().endsWith('/api/v1/library/install'))
			installRequests.push(request.url());
	});
	const confirm = page.getByRole('checkbox', { name: /I confirm exact plan/ });
	await confirm.check();
	await expect(page.getByRole('button', { name: 'Install package' })).toBeDisabled();
	expect(installRequests).toEqual([]);
	for (const checkbox of await page.getByRole('checkbox', { name: /I reviewed/ }).all())
		await checkbox.check();
	await page.getByLabel(`Main · ${mainName}`).fill(`${mainName} reviewed`);
	await expect(confirm).toHaveCount(0);
	await page.getByRole('button', { name: 'Prepare installation' }).click();
	await expect(page.getByRole('checkbox', { name: /I confirm exact plan/ })).not.toBeChecked();
	for (const checkbox of await page.getByRole('checkbox', { name: /I reviewed/ }).all())
		await expect(checkbox).not.toBeChecked();
	await expect(page.getByRole('button', { name: 'Install package' })).toBeDisabled();
	for (const checkbox of await page.getByRole('checkbox', { name: /I reviewed/ }).all())
		await checkbox.check();

	await page.setViewportSize(PHONE);
	const width = await page.evaluate(() => document.documentElement.scrollWidth);
	expect(width).toBeLessThanOrEqual(PHONE.width);
	const freshConfirm = page.getByRole('checkbox', { name: /I confirm exact plan/ });
	await freshConfirm.focus();
	await page.keyboard.press('Space');
	await expect(freshConfirm).toBeChecked();
	await page.getByRole('button', { name: 'Install package' }).click();
	await expect(page.locator('[data-package-receipt]')).toBeFocused();
	await expect(page.getByText('no runs or issues created', { exact: false })).toBeVisible();
	await expect(page.getByText('No project default changed', { exact: false })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Open workflow' }).first()).toHaveAttribute(
		'href',
		/^\/workflows\//
	);
	expect(installRequests).toHaveLength(1);

	const api = apiClient(request, BOB.apiKey);
	for (const project of projects) {
		const schedules = await body<{ items: unknown[] }>(
			await api.get(`/api/v1/projects/${project.id}/schedules`)
		);
		expect(schedules.items).toEqual([]);
	}
});

test('retains exact-plan recovery for an explicit unknown outcome across reload', async ({
	page
}) => {
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	await page.getByRole('button', { name: 'Prepare installation' }).click();
	await expect(page.getByRole('heading', { name: 'Complete installation plan' })).toBeVisible();
	for (const checkbox of await page.getByRole('checkbox', { name: /I reviewed/ }).all())
		await checkbox.check();
	await page.getByRole('checkbox', { name: /I confirm exact plan/ }).check();
	await page.route('**/api/v1/library/install', async (route) =>
		route.fulfill({
			status: 503,
			contentType: 'application/json',
			body: JSON.stringify({
				error: {
					code: 'install_outcome_unknown',
					message: 'The result could not be determined',
					details: null
				}
			})
		})
	);
	await page.getByRole('button', { name: 'Install package' }).click();
	await expect(page.getByRole('heading', { name: 'Installation result unknown' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Retry same plan safely' })).toBeVisible();
	const saved = await page.evaluate(() =>
		JSON.parse(sessionStorage.getItem('tines:workflow-package-install-recovery:v1') ?? 'null')
	);
	expect(saved).toMatchObject({ planId: expect.any(String), planToken: expect.any(String) });
	expect(JSON.stringify(saved)).not.toContain(mainName);
	await page.reload({ waitUntil: 'networkidle' });
	await expect(page.getByRole('heading', { name: 'Installation result unknown' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible();
	await page.getByRole('button', { name: 'Check result' }).click();
	await expect(page.getByText('this is not proof of rollback', { exact: false })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Prepare installation' })).toHaveCount(0);
});

test('links field and capability failures to their normal destination pages', async ({ page }) => {
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(missingWorkflowPath);
	await page.getByLabel('Filing label').selectOption({ label: 'Create “qa”' });
	await page.getByRole('button', { name: 'Prepare installation' }).click();
	await expect(page.getByRole('link', { name: 'Create a destination workflow' })).toHaveAttribute(
		'href',
		'/workflows/new'
	);

	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	const tier = page
		.getByRole('group', { name: 'Optional destination tier preferences' })
		.locator('select')
		.first();
	await tier.selectOption({ index: 1 });
	await page.getByRole('button', { name: 'Prepare installation' }).click();
	await expect(page.getByRole('link', { name: 'Configure destination runners' })).toHaveAttribute(
		'href',
		'/agents#routing'
	);
});

test('links the settings entry point and routes whole-library files without preparing them', async ({
	page
}) => {
	await gotoHydrated(page, '/settings/export-import');
	await expect(page.getByRole('link', { name: 'Install workflow package' })).toHaveAttribute(
		'href',
		'/workflows/import'
	);
	await gotoHydrated(page, '/workflows/import');
	const legacy = join(mkdtempSync(join(tmpdir(), 'tines-library-import-')), 'library.json');
	writeFileSync(
		legacy,
		JSON.stringify({
			format: 'tines.library',
			version: 2,
			projects: [],
			workflows: [],
			context: []
		})
	);
	await page.getByLabel('Workflow package file').setInputFiles(legacy);
	await expect(page.getByRole('heading', { name: 'Whole-library import' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Open whole-library importer' })).toHaveAttribute(
		'href',
		'/settings/export-import'
	);
});
