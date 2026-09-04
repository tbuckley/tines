import type { IssueDetail, Project, WorkflowResponse } from '@tines/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, runId, signIn } from './helpers';

/**
 * A folder artifact's row on a phone (Tines/30): the type icon, the thumbnail
 * strip and the action buttons all refuse to shrink, so at 390px the text
 * column was the only thing left to give — measured 14px wide, 0px once a
 * stale badge added a Reaffirm button, wrapping the metadata one word per
 * line. The row now wraps instead: the text claims a readable width and the
 * actions drop to their own line. Desktop must stay a single line.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/** A real 1×1 PNG, so the thumbnails lay out as images rather than alt text. */
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
);

const projectName = `artifacts-panel-${runId}`;
let project: Project;
let plain: IssueDetail;
let stale: IssueDetail;

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({
		baseURL: test.info().project.use.baseURL
	});
	const api = apiClient(request, ALICE.apiKey);
	project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));

	// Eight images: more than the three thumbnails a row shows, as in the
	// screenshot folders agents actually attach.
	const multipart = Object.fromEntries(
		Array.from({ length: 8 }, (_, i) => [
			`f${i}`,
			{ name: `shot-${i}.png`, mimeType: 'image/png', buffer: PNG }
		])
	);
	const attachPhotos = (issueId: string) =>
		request.put(`/api/v1/issues/${issueId}/artifacts/photos/folder`, {
			headers: { authorization: `Bearer ${ALICE.apiKey}` },
			multipart
		});

	plain = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, { title: `Panel ${runId}` })
	);
	await attachPhotos(plain.id);

	// The stale variant is the tight one: the badge widens the text and the
	// Reaffirm button widens the actions. Attaching before the move leaves the
	// version predating the state entry, and Implementation's only way out
	// requires the slot — so the row renders both.
	const workflow = await body<WorkflowResponse>(
		await api.post('/api/v1/workflows', {
			name: `Panel loop ${runId}`,
			initial_state: 'Design',
			states: [
				{ name: 'Design', category: 'active' },
				{ name: 'Implementation', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				{ name: 'approve', from: 'Design', to: 'Implementation' },
				{
					name: 'ship',
					from: 'Implementation',
					to: 'Done',
					requires: [{ artifact: 'photos', type: 'folder' }]
				}
			]
		})
	);
	stale = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, {
			title: `Panel stale ${runId}`,
			workflow_id: workflow.id
		})
	);
	await attachPhotos(stale.id);
	await api.post(`/api/v1/issues/${stale.id}/transition`, { action: 'approve' });

	await request.dispose();
});

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

/**
 * On a phone the Artifacts panel folds to one row (Tines/165); open it before
 * reaching for anything inside. A no-op on desktop, where there is no fold.
 * Retried across the hydration window: the row is a Svelte listener.
 */
async function unfoldArtifacts(page: Page): Promise<void> {
	const fold = page.getByRole('button', { name: /^Artifacts\b/ });
	if (!(await fold.isVisible())) return;
	await expect(async () => {
		if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
		expect(await fold.getAttribute('aria-expanded')).toBe('true');
	}).toPass({ timeout: 15_000 });
}

const issueUrl = (issue: IssueDetail) =>
	`/issues/${encodeURIComponent(projectName)}/${issue.number}`;

/** The `photos` row, keyed off the artifact-name button inside it. */
function photosRow(page: Page): Locator {
	return page
		.getByRole('listitem')
		.filter({ has: page.getByRole('button', { name: 'photos', exact: true }) });
}

type Box = { x: number; y: number; width: number; height: number };
type RowGeometry = { row: Box; text: Box; meta: Box; actions: Box };

/**
 * Every box of a row, read from one layout pass (Tines/123). The parts are
 * reached structurally: the row's first div is the text column and the second
 * the actions, and `meta` is the version/actor/age line the crushed column
 * mangled — the last paragraph of the text column.
 *
 * These tests are all about how the row's parts sit relative to each other,
 * and a `boundingBox()` per part is a separate round trip: the issue page is
 * still settling after the row is visible, so two reads can land either side
 * of a reflow and the difference between them then measures the page shift
 * rather than the row. That is how the desktop assertion below came to fail
 * at exactly its boundary in a longer suite run — its two reads were 6px of
 * page shift apart. Reading every box inside one `evaluate` makes the
 * comparisons internally consistent whatever the page is doing.
 */
function rowGeometry(row: Locator): Promise<RowGeometry> {
	return row.evaluate((li) => {
		const box = (el: Element): Box => {
			const { x, y, width, height } = el.getBoundingClientRect();
			return { x, y, width, height };
		};
		const columns = li.querySelectorAll(':scope > div');
		const paragraphs = columns[0].querySelectorAll('p');
		return {
			row: box(li),
			text: box(columns[0]),
			meta: box(paragraphs[paragraphs.length - 1]),
			actions: box(columns[columns.length - 1])
		};
	});
}

/**
 * `rowGeometry` once the layout has stopped moving: two reads a beat apart
 * agreeing. The row slides in, and content above the panel can reflow after
 * hydration — measuring through that gives a box from a frame no assertion
 * here means to describe.
 */
async function settledGeometry(row: Locator): Promise<RowGeometry> {
	let settled = await rowGeometry(row);
	await expect(async () => {
		const before = JSON.stringify(settled);
		settled = await rowGeometry(row);
		expect(JSON.stringify(settled)).toBe(before);
	}).toPass({ intervals: [100, 100, 200, 400] });
	return settled;
}

test('a folder row keeps its metadata readable on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(issueUrl(plain));
	await unfoldArtifacts(page);

	const row = photosRow(page);
	await expect(row).toBeVisible();
	const { meta } = await settledGeometry(row);

	// Was 14px — one word per line, ten lines tall. The width is the column's,
	// not the text's, so it does not move with the age wording; the height
	// still allows the line to wrap once, which the bug's ten lines cannot.
	expect(meta.width).toBeGreaterThan(180);
	expect(meta.height).toBeLessThan(40);

	// The thumbnail strip gives up its extra images at this width; the first
	// still opens the viewer.
	await expect(row.locator('img')).toHaveCount(3);
	await expect(row.locator('img').first()).toBeVisible();
	await expect(row.locator('img').nth(1)).toBeHidden();
});

test('a stale folder row keeps its metadata and actions on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(issueUrl(stale));
	await unfoldArtifacts(page);

	const row = photosRow(page);
	await expect(row.getByText('stale')).toBeVisible();

	// Was 0px: the Reaffirm button took the last of the row.
	const { text, meta, actions } = await settledGeometry(row);
	expect(meta.width).toBeGreaterThan(180);

	// The State card now leads the page on a phone (Tines/128), so this row can
	// start below the fold — scroll it in first. What this test is about is the
	// horizontal squeeze that used to clip the actions off the right edge
	// (Tines/123), not where the row happens to sit down the page.
	await row.scrollIntoViewIfNeeded();

	// Every action stays on screen, on its own line under the text.
	for (const name of [
		'Reaffirm',
		'View photos (content and version history)',
		'Attach a new version of photos',
		'Delete photos'
	]) {
		await expect(row.getByRole('button', { name })).toBeInViewport();
	}
	expect(actions.y).toBeGreaterThanOrEqual(text.y + text.height);
});

test('a folder row stays one line on a desktop', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(issueUrl(plain));
	await unfoldArtifacts(page);

	const row = photosRow(page);
	await expect(row).toBeVisible();

	// All three thumbnails, and nothing wrapped: the row is a single line.
	const thumbs = row.locator('img');
	await expect(thumbs).toHaveCount(3);
	for (let i = 0; i < 3; i++) await expect(thumbs.nth(i)).toBeVisible();

	// Nothing wrapped: the actions sit beside the text column, sharing its
	// flex line, and the row is one line tall. Stated as a relation between
	// the two columns rather than as a y-delta against the metadata text,
	// whose height moves with its wording (Tines/123).
	const { row: rowBox, text, actions } = await settledGeometry(row);
	expect(rowBox.height).toBeLessThan(72);
	expect(actions.x).toBeGreaterThanOrEqual(text.x + text.width);
	expect(actions.y).toBeLessThan(text.y + text.height);
	expect(text.y).toBeLessThan(actions.y + actions.height);
});
