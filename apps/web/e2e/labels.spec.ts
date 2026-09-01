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
	// Five labels on one issue, the first deliberately long: on a phone only
	// what fits shows, the rest become a "+N", and it stays one line.
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
	// One label too wide for a phone row on its own: nothing fits, so the strip
	// is just the count.
	const wideName = `w-single-label-far-too-wide-for-a-phone-${runId}`;

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
				// Long on purpose: a short title would fit beside the chips even
				// without the one-line rule, and the height assertion below would
				// pass vacuously.
				title: `Crowded ${runId} — runner daemon drops the log tail when a run is canceled`,
				labels: crowdNames
			})
		);
		await api.post('/api/v1/labels', { name: wideName, color: 'orange' });
		await api.post(`/api/v1/projects/${project.id}/issues`, {
			title: `Wide ${runId}`,
			labels: [wideName]
		});
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

	test('a phone row keeps its labels to one line below the title', async ({ page }) => {
		const list = `/issues?project=${encodeURIComponent(projectName)}`;
		const crowdedRow = page.getByRole('link', { name: new RegExp(`Crowded ${runId}`) });
		// The unlabelled row is the yardstick: labels may cost one line, never two.
		const plainRow = page.getByRole('link', { name: new RegExp(`Plain ${runId}`) });
		const strip = crowdedRow.getByTestId('label-strip');

		await page.setViewportSize(PHONE);
		await page.goto(list);
		await expect(crowdedRow).toBeVisible();
		// The measurement copy carries the same names, so pin the visible chips.
		const overflow = strip.locator('span:visible', { hasText: /^\+\d+$/ });
		await expect(overflow).toBeVisible();
		// Only what fits is shown, and what does not is counted, not dropped: the
		// visible chips plus the "+N" always account for all five labels.
		const shown = await strip.locator('> span:visible').count();
		const hidden = Number((await overflow.textContent())!.trim().slice(1));
		expect(shown - 1 + hidden).toBe(crowdNames.length);
		// The names behind the count stay reachable.
		await expect(overflow).toHaveAttribute('title', new RegExp(crowdNames.at(-1)!));

		// One line, whatever it holds: the strip is a single chip tall...
		const stripBox = await strip.boundingBox();
		expect(stripBox!.height).toBeLessThan(24);
		// ...and the row it sits in is one line taller than an unlabelled one.
		const crowdedBox = await crowdedRow.boundingBox();
		const plainBox = await plainRow.boundingBox();
		const grew = crowdedBox!.height - plainBox!.height;
		expect(grew).toBeGreaterThan(4);
		expect(grew).toBeLessThan(28);

		// A single label too wide for the row is a bare "+1", not a clipped chip.
		const wideRow = page.getByRole('link', { name: new RegExp(`Wide ${runId}`) });
		await expect(wideRow.getByTestId('label-strip').locator('span:visible')).toHaveText(['+1']);

		// Wider viewport: labels go back inline — three chips and "+2", no strip.
		await page.setViewportSize(DESKTOP);
		await expect(strip).toBeHidden();
		// A name can appear three times in the row (inline chip, strip chip, the
		// strip's measurement copy), so every assertion here is on what renders.
		const rendered = (text: string) => crowdedRow.locator(`span:text-is("${text}"):visible`);
		await expect(rendered(crowdNames[2])).toBeVisible();
		await expect(rendered(crowdNames[3])).toHaveCount(0);
		await expect(rendered('+2')).toBeVisible();
		// A long name is ellipsed rather than allowed to push the title out.
		const chipBox = await rendered(crowdNames[0]).boundingBox();
		expect(chipBox!.width).toBeLessThan(130);
		// Inline again, so a labelled row costs no height at this width.
		const wideBox = await crowdedRow.boundingBox();
		expect(Math.abs(wideBox!.height - plainBox!.height)).toBeLessThan(1);

		// Nothing is lost — the detail page still shows every label.
		await page.setViewportSize(PHONE);
		await page.goto(`/issues/${encodeURIComponent(projectName)}/${crowded.number}`);
		for (const name of crowdNames) {
			await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
		}
	});
});
