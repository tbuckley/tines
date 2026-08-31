import type { IssueDetail, Label, Project } from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, runId, signIn } from './helpers';

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/**
 * Labels in the browser: the chip on a list row, the editable card on the
 * detail page, the filter bar, and the settings page. The API-level
 * behaviour (AND filtering, run-key rules) lives in api.spec.ts.
 */
test.describe.serial('issue labels UI', () => {
	const projectName = `labels-${runId}`;
	const bugName = `bug-${runId}`;
	const p1Name = `p1-${runId}`;
	// Five labels on one issue, the first deliberately long: a phone row shows
	// one chip (ellipsed) plus "+4" and must not grow a second line.
	const crowdNames = [
		`c1-a-really-long-label-name-${runId}`,
		`c2-${runId}`,
		`c3-${runId}`,
		`c4-${runId}`,
		`c5-${runId}`
	];
	let project: Project;
	let labelled: IssueDetail;
	let plain: IssueDetail;
	let crowded: IssueDetail;
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
		for (const name of crowdNames) await api.post('/api/v1/labels', { name, color: 'green' });
		crowded = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: `Crowded ${runId}`,
				labels: crowdNames
			})
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

	test('a crowded row stays one line on a phone, with the full set on the detail page', async ({
		page
	}) => {
		const list = `/issues?project=${encodeURIComponent(projectName)}`;
		const crowdedRow = page.getByRole('link', { name: new RegExp(`Crowded ${runId}`) });
		const oneLabelRow = page.getByRole('link', { name: new RegExp(`Labelled ${runId}`) });

		await page.setViewportSize(PHONE);
		await page.goto(list);
		await expect(crowdedRow).toBeVisible();
		// One chip, four folded into the counter.
		await expect(crowdedRow.getByText(crowdNames[0], { exact: true })).toBeVisible();
		await expect(crowdedRow.getByText(crowdNames[1], { exact: true })).toBeHidden();
		await expect(crowdedRow.getByText('+4', { exact: true })).toBeVisible();
		// The whole point: five labels cost exactly as much height as one.
		const crowdedBox = await crowdedRow.boundingBox();
		const oneLabelBox = await oneLabelRow.boundingBox();
		expect(Math.abs(crowdedBox!.height - oneLabelBox!.height)).toBeLessThan(1);
		// A long name is ellipsed rather than allowed to push the row wider.
		const chipBox = await crowdedRow.getByText(crowdNames[0], { exact: true }).boundingBox();
		expect(chipBox!.width).toBeLessThan(PHONE.width / 2);

		// Wider viewport, wider budget: three chips and "+2".
		await page.setViewportSize(DESKTOP);
		await expect(crowdedRow.getByText(crowdNames[2], { exact: true })).toBeVisible();
		await expect(crowdedRow.getByText(crowdNames[3], { exact: true })).toBeHidden();
		await expect(crowdedRow.getByText('+2', { exact: true })).toBeVisible();

		// Nothing is lost — the detail page still shows every label.
		await page.setViewportSize(PHONE);
		await page.goto(`/issues/${encodeURIComponent(projectName)}/${crowded.number}`);
		for (const name of crowdNames) {
			await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
		}
	});
});
