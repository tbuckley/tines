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
	// `-ui-` rather than plain `labels-`/`bug-`/`p1-`: api.spec.ts's own label
	// block claims those, `runId` is per-process so a full-suite run shares it,
	// and a project name is unique per user — the duplicate 422s in beforeAll
	// where nothing checks the status, leaving this spec looking at an empty
	// list rather than at a failure.
	const projectName = `labels-ui-${runId}`;
	const bugName = `bug-ui-${runId}`;
	const p1Name = `p1-ui-${runId}`;
	// Five labels on one issue, the last deliberately long: they never fit a
	// phone's metadata line, so the row shows one chip carrying the count.
	const crowdNames = [
		`c1-${runId}`,
		`c2-${runId}`,
		`c3-${runId}`,
		`c4-${runId}`,
		`c5-a-really-long-label-name-${runId}`
	];
	let project: Project;
	let labelled: IssueDetail;
	let plain: IssueDetail;
	let crowded: IssueDetail;
	let bug: Label;
	// One label too wide for a phone row on its own: it does not fit, so the
	// strip is the count ("1 label") rather than a name cut mid-word.
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
		// The filter box caps at the API's own limit, so a too-long name is
		// never offered for creation and never costs a round trip.
		await expect(page.getByLabel('Filter labels')).toHaveAttribute('maxlength', '50');
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

		// A `change` dispatched before hydration finishes is lost — the input is
		// server-rendered, its handler is not — so the rename is retried. But
		// `fill` only produces a `change` when the value actually moves, and a
		// swallowed attempt leaves the field already reading `rename`, so a naive
		// retry is a silent no-op forever. Blanking the field and blurring first
		// makes every attempt a real change.
		await expect(async () => {
			const field = page.getByLabel(`Rename ${bugName}`);
			await field.fill('');
			await field.blur();
			await field.fill(rename);
			await field.blur();
			await expect(page.getByLabel(`Rename ${rename}`)).toBeVisible({ timeout: 3000 });
		}).toPass({ timeout: 15_000 });

		// The rename reaches the chips that render from the same row.
		await page.goto(`/issues/${encodeURIComponent(projectName)}/${labelled.number}`);
		await expect(page.getByText(rename).first()).toBeVisible();
	});

	test('a row shows its labels whole or as a count, costing no height', async ({ page }) => {
		const list = `/issues?project=${encodeURIComponent(projectName)}`;
		const crowdedRow = page.getByRole('link', { name: new RegExp(`Crowded ${runId}`) });
		// One-line titles with no label and with one: the yardsticks for "labels
		// cost no height".
		const plainRow = page.getByRole('link', { name: new RegExp(`Plain ${runId}`) });
		const wideRow = page.getByRole('link', { name: new RegExp(`Wide ${runId}`) });
		const strip = crowdedRow.getByTestId('label-strip');
		// The measurement copy carries the same names, so pin what renders.
		const visibleChips = (s: typeof strip) => s.locator('> div:not([aria-hidden]) > span:visible');

		await page.setViewportSize(PHONE);
		await page.goto(list);
		await expect(crowdedRow).toBeVisible();
		// Five chips never fit a phone's metadata line, so the set is one chip
		// carrying the count — never a subset, never a name cut mid-word.
		// A string, not a regex: Playwright normalizes whitespace for the former only.
		const count = visibleChips(strip).filter({ hasText: '5 labels' });
		await expect(count).toBeVisible();
		await expect(visibleChips(strip)).toHaveCount(1);
		// The names behind the count stay reachable.
		await expect(count).toHaveAttribute('title', new RegExp(crowdNames.at(-1)!));
		// Nothing spills: the chip ends inside the strip.
		const stripRect = (await strip.boundingBox())!;
		const chipRect = (await count.boundingBox())!;
		expect(chipRect.x + chipRect.width).toBeLessThanOrEqual(stripRect.x + stripRect.width + 1);
		expect(chipRect.x).toBeGreaterThanOrEqual(stripRect.x - 1);

		// One line, whatever it holds: the strip is a single chip tall...
		expect(stripRect.height).toBeLessThan(24);

		// ...and it rides the metadata line the state is already on, starting
		// after it — read in one layout pass, so the boxes are the same moment
		// (Tines/123).
		const line = await crowdedRow.evaluate((row) => {
			const box = (el: Element | null) => {
				const r = el!.getBoundingClientRect();
				return { x: r.x, right: r.right, top: r.top, bottom: r.bottom };
			};
			return {
				row: box(row),
				state: box(row.querySelector('[style*="issue-state"]')),
				strip: box(row.querySelector('[data-testid="label-strip"]')),
				title: box(row.querySelector('[style*="issue-title"]'))
			};
		});
		expect(line.strip.x).toBeGreaterThanOrEqual(line.state.right);
		// Same line as the state: their vertical spans overlap.
		expect(line.strip.top).toBeLessThan(line.state.bottom);
		expect(line.strip.bottom).toBeGreaterThan(line.state.top);
		// Below the title, not beside it.
		expect(line.strip.top).toBeGreaterThanOrEqual(line.title.bottom);
		// That line is not indented under the title: it gets the row's full
		// width.
		expect(line.state.x - line.row.x).toBeLessThan(24);

		// The number renders once.
		const number = (row: typeof crowdedRow) => row.locator(`span:text-is("#${crowded.number}")`);
		await expect(number(crowdedRow).locator('visible=true')).toHaveCount(1);

		// A single label too wide for the line is the count too ("1 label"),
		// not a clipped chip — and it costs the row nothing: same height as
		// the unlabelled row beside it.
		await expect(visibleChips(wideRow.getByTestId('label-strip'))).toHaveText(['1 label']);
		const wideBox = await wideRow.boundingBox();
		const plainBox = await plainRow.boundingBox();
		expect(Math.abs(wideBox!.height - plainBox!.height)).toBeLessThan(1);
		// Two title lines, one metadata line: never more.
		expect((await crowdedRow.boundingBox())!.height).toBeLessThan(90);

		// Wider viewport: the strip stays, and the wide name now has room, so
		// it shows whole — a dot chip whose text is not clipped.
		await page.setViewportSize(DESKTOP);
		await expect(strip).toBeVisible();
		await expect(number(crowdedRow).locator('visible=true')).toHaveCount(1);
		const wideChip = wideRow.locator(`span:visible`, { hasText: wideName }).last();
		await expect(wideChip).toBeVisible();
		expect(await wideChip.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
		// Whole or counted, never cut: every visible chip in the crowded row
		// ends inside the strip, and the title keeps the larger share of the row
		// (labels are capped at a quarter of it).
		const chips = visibleChips(strip);
		const shown = await chips.count();
		expect(shown === crowdNames.length || shown === 1).toBe(true);
		const desktopStrip = (await strip.boundingBox())!;
		for (const chip of await chips.all()) {
			const b = (await chip.boundingBox())!;
			expect(b.x + b.width).toBeLessThanOrEqual(desktopStrip.x + desktopStrip.width + 1);
			expect(await chip.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
		}
		const rowBox = (await crowdedRow.boundingBox())!;
		const titleText = crowdedRow.locator('[style*="issue-title"]');
		const titleCell = (await titleText.locator('..').boundingBox())!;
		expect(titleCell.width).toBeGreaterThan(rowBox.width * 0.45);
		// ...and this title, which fits that share, is not truncated at all.
		expect(await titleText.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
		// A labelled row costs no height at this width either — one 40px line,
		// like the plain row.
		const crowdedDesktopBox = await crowdedRow.boundingBox();
		const plainDesktopBox = await plainRow.boundingBox();
		expect(Math.abs(crowdedDesktopBox!.height - plainDesktopBox!.height)).toBeLessThan(1);

		// Nothing is lost — the detail page still shows every label.
		await page.setViewportSize(PHONE);
		await page.goto(`/issues/${encodeURIComponent(projectName)}/${crowded.number}`);
		for (const name of crowdNames) {
			await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
		}
	});
});
