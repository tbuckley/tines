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

const issueUrl = (issue: IssueDetail) =>
	`/issues/${encodeURIComponent(projectName)}/${issue.number}`;

/** The `photos` row, keyed off the artifact-name button inside it. */
function photosRow(page: Page): Locator {
	return page
		.getByRole('listitem')
		.filter({ has: page.getByRole('button', { name: 'photos', exact: true }) });
}

/**
 * The version/actor/age line — the text the crushed column mangled. Reached
 * structurally: the row's first div is the text column, the actions the second.
 */
const metaLine = (row: Locator) => row.locator('> div').first().locator('p').last();

async function width(locator: Locator): Promise<number> {
	const box = await locator.boundingBox();
	expect(box).not.toBeNull();
	return box!.width;
}

test('a folder row keeps its metadata readable on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(issueUrl(plain));

	const row = photosRow(page);
	await expect(row).toBeVisible();
	const meta = metaLine(row);

	// Was 14px — one word per line, ten lines tall.
	expect(await width(meta)).toBeGreaterThan(180);
	const box = await meta.boundingBox();
	expect(box!.height).toBeLessThan(40);

	// The thumbnail strip gives up its extra images at this width; the first
	// still opens the viewer.
	await expect(row.locator('img')).toHaveCount(3);
	await expect(row.locator('img').first()).toBeVisible();
	await expect(row.locator('img').nth(1)).toBeHidden();
});

test('a stale folder row keeps its metadata and actions on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(issueUrl(stale));

	const row = photosRow(page);
	await expect(row.getByText('stale')).toBeVisible();

	// Was 0px: the Reaffirm button took the last of the row.
	expect(await width(metaLine(row))).toBeGreaterThan(180);

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
	const rowBox = await row.boundingBox();
	const actionsBox = await row.getByRole('button', { name: 'Reaffirm' }).boundingBox();
	expect(actionsBox!.y).toBeGreaterThan(rowBox!.y + 20);
});

test('a folder row stays one line on a desktop', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(issueUrl(plain));

	const row = photosRow(page);
	await expect(row).toBeVisible();

	// All three thumbnails, and nothing wrapped: the row is a single line.
	const thumbs = row.locator('img');
	await expect(thumbs).toHaveCount(3);
	for (let i = 0; i < 3; i++) await expect(thumbs.nth(i)).toBeVisible();

	const rowBox = await row.boundingBox();
	expect(rowBox!.height).toBeLessThan(72);
	const trash = await row.getByRole('button', { name: 'Delete photos' }).boundingBox();
	const meta = await metaLine(row).boundingBox();
	expect(Math.abs(trash!.y - meta!.y)).toBeLessThan(24);
});
