import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	automatedPackage,
	type Project,
	type ValidateLibraryResponse,
	type WorkflowPackageDocument
} from '@tines/shared';
import { expect, test } from '@playwright/test';
import { BOB } from './constants.mjs';
import { apiClient, body, DESKTOP, gotoHydrated, PHONE, runId, signIn } from './helpers';

const suffix = ` browser import ${runId}`;
let packagePath: string;
let mainName: string;
let dependencyName: string;
let projects: Project[];

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
	const api = apiClient(request, BOB.apiKey);
	const candidate = automatedPackage();
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
	await request.dispose();
});

test.beforeEach(async ({ context }) => signIn(context, BOB.sessionToken));

test('reviews, confirms and installs an independent project-free package through the real backend', async ({
	page,
	request
}) => {
	await page.setViewportSize(DESKTOP);
	await gotoHydrated(page, '/workflows');
	await page.getByRole('link', { name: 'Install package' }).click();
	await expect(page).toHaveURL('/workflows/import');
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
	await expect(page.getByText(`${mainName} (imported)`, { exact: false })).toBeVisible();
	await expect(page.getByText(`${dependencyName} (imported)`, { exact: false })).toBeVisible();
	await expect(page.getByText('Exact declared substitutions')).toBeVisible();
	await expect(page.getByText('Original', { exact: true }).first()).toBeVisible();
	await expect(page.getByText('Installed value', { exact: true }).first()).toBeVisible();
	for (const checkbox of await page.getByRole('checkbox', { name: /I reviewed/ }).all())
		await checkbox.check();

	await page.setViewportSize(PHONE);
	const width = await page.evaluate(() => document.documentElement.scrollWidth);
	expect(width).toBeLessThanOrEqual(PHONE.width);
	const confirm = page.getByRole('checkbox', { name: /I confirm exact plan/ });
	await confirm.focus();
	await page.keyboard.press('Space');
	await expect(confirm).toBeChecked();
	await page.getByRole('button', { name: 'Install package' }).click();
	await expect(page.locator('[data-package-receipt]')).toBeFocused();
	await expect(page.getByText('no runs or issues created', { exact: false })).toBeVisible();
	await expect(page.getByText('No project default changed', { exact: false })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Open workflow' }).first()).toHaveAttribute(
		'href',
		/^\/workflows\//
	);

	const api = apiClient(request, BOB.apiKey);
	for (const project of projects) {
		const schedules = await body<{ items: unknown[] }>(
			await api.get(`/api/v1/projects/${project.id}/schedules`)
		);
		expect(schedules.items).toEqual([]);
	}
});

test('links the settings entry point and routes whole-library files without preparing them', async ({
	page
}) => {
	await gotoHydrated(page, '/settings/export-import');
	await page.getByRole('link', { name: 'Install workflow package' }).click();
	await expect(page).toHaveURL('/workflows/import');
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
