import type { IssueDetail, Label, Project } from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, runId, signIn } from './helpers';

/**
 * Labels in the browser: the chip on a list row, the editable card on the
 * detail page, the filter bar, and the settings page. The API-level
 * behaviour (AND filtering, run-key rules) lives in api.spec.ts.
 */
test.describe.serial('issue labels UI', () => {
	const projectName = `labels-${runId}`;
	const bugName = `bug-${runId}`;
	const p1Name = `p1-${runId}`;
	let project: Project;
	let labelled: IssueDetail;
	let plain: IssueDetail;
	let bug: Label;

	test.beforeAll(async ({ playwright }) => {
		const request = await playwright.request.newContext({
			baseURL: test.info().project.use.baseURL
		});
		const api = apiClient(request, ALICE.apiKey);
		project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
		bug = await body<Label>(await api.post('/api/v1/labels', { name: bugName, color: 'red' }));
		await api.post('/api/v1/labels', { name: p1Name, color: 'blue' });
		labelled = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: `Labelled ${runId}`,
				labels: [bugName]
			})
		);
		plain = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, { title: `Plain ${runId}` })
		);
		await request.dispose();
	});

	test.beforeEach(async ({ context }) => {
		await signIn(context, ALICE.sessionToken);
	});

	test('list rows carry chips and the filter narrows to them', async ({ page }) => {
		await page.goto(`/issues?project=${encodeURIComponent(projectName)}`);
		await expect(page.getByRole('link', { name: new RegExp(`Labelled ${runId}`) })).toBeVisible();
		await expect(page.getByText(bugName, { exact: true }).first()).toBeVisible();

		// The filter carries ids, so the URL survives a rename.
		await page.goto(`/issues?project=${encodeURIComponent(projectName)}&label=${bug.id}`);
		await expect(page.getByText(`Labelled ${runId}`)).toBeVisible();
		await expect(page.getByText(`Plain ${runId}`)).toHaveCount(0);
		// The trigger reflects the active filter rather than "All labels".
		await expect(page.getByRole('button', { name: 'Filter by label' })).not.toContainText(
			'All labels'
		);
	});

	test('the detail card adds and removes a label', async ({ page }) => {
		await page.goto(`/issues/${encodeURIComponent(projectName)}/${plain.number}`);
		const card = page.locator('section', { has: page.getByRole('heading', { name: 'Labels' }) });
		await expect(card.getByText('No labels.')).toBeVisible();

		await expect(async () => {
			await card.getByRole('button', { name: 'Edit' }).click();
			await expect(page.getByRole('button', { name: p1Name })).toBeVisible({ timeout: 2000 });
		}).toPass({ timeout: 15_000 });
		await page.getByRole('button', { name: p1Name }).click();
		await expect(card.getByText(p1Name)).toBeVisible();

		// Survives a reload: the add really reached the server.
		await page.reload();
		await expect(card.getByText(p1Name)).toBeVisible();

		await card.getByRole('button', { name: `Remove label ${p1Name}` }).click();
		await expect(card.getByText('No labels.')).toBeVisible();
		await page.reload();
		await expect(card.getByText('No labels.')).toBeVisible();
	});

	test('the settings page lists labels with their usage and renames one', async ({ page }) => {
		await page.goto('/settings/labels');
		const rename = `${bugName}-renamed`;
		const row = page.locator('li', { has: page.getByLabel(`Rename ${bugName}`) });
		await expect(row.getByRole('link', { name: '1 issue' })).toBeVisible();

		await expect(async () => {
			await page.getByLabel(`Rename ${bugName}`).fill(rename);
			await page.getByLabel(`Rename ${bugName}`).blur();
			await expect(page.getByLabel(`Rename ${rename}`)).toBeVisible({ timeout: 3000 });
		}).toPass({ timeout: 15_000 });

		// The rename reaches the chips that render from the same row.
		await page.goto(`/issues/${encodeURIComponent(projectName)}/${labelled.number}`);
		await expect(page.getByText(rename).first()).toBeVisible();
	});
});
