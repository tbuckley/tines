import type { IssueDetail, Project } from '@tines/shared';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { apiClient, body, gotoHydrated, resetFocus, runId, signIn, issuePath } from './helpers';

/**
 * A title with a long unbroken run of characters — a pasted URL is enough
 * (Tines/45). Nothing rendering a raw title had a breaking rule, so the
 * title set the document width and dragged every card on the page with it:
 * measured 838px of document in a 390px viewport for the URL title, 4773px
 * for a 400-character token. The list was never affected (it truncates); the
 * detail heading, the duplicate-of banner and the activity feed were.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/** Repro A: a pasted CI link, the realistic input. */
const URL_TITLE = `Investigate https://github.com/tbuckley/tines/actions/runs/1234567890/job/9876543210?pr=42&check_suite_focus=true failing ${runId}`;
/** Repro B: a 400-character unbroken token, the worst case. */
const BLOB_TITLE = `Paste ${'a1b2c3d4e5'.repeat(40)} ${runId}`;

let projectName: string;
let project: Project;
let urlIssue: IssueDetail;
let blobIssue: IssueDetail;
let dupIssue: IssueDetail;

test.beforeAll(async ({ apiFor, uniqueName }) => {
	projectName = uniqueName('longtitle');
	const api = apiFor(ALICE);
	project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));

	const create = async (title: string) =>
		body<IssueDetail>(await api.post(`/api/v1/projects/${project.id}/issues`, { title }));
	urlIssue = await create(URL_TITLE);
	blobIssue = await create(BLOB_TITLE);

	// The duplicate-of banner is the one other place the detail page prints a
	// title it did not choose: this issue's page renders blobIssue's.
	dupIssue = await create(`Duplicate ${runId}`);
	await api.post(`/api/v1/issues/${dupIssue.id}/links`, {
		kind: 'duplicate_of',
		issue_id: blobIssue.id
	});
});

test.use({ signedIn: ALICE });

test.beforeEach(async ({ request }) => {
	// Specs share one user: a focus left behind would scope this one's lists.
	await resetFocus(request);
});

/** How far the document scrolls past the viewport, in px. 0 when it fits. */
async function overflow(page: Page): Promise<number> {
	return page.evaluate(() => {
		const el = document.documentElement;
		return el.scrollWidth - el.clientWidth;
	});
}

for (const [label, viewport] of [
	['a phone', PHONE],
	['a desktop', DESKTOP]
] as const) {
	test(`a pasted-URL title does not widen the detail page on ${label}`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await page.goto(issuePath(projectName, urlIssue.number));
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

		// Was +448px on the phone, +34px on the desktop.
		expect(await overflow(page)).toBe(0);
	});

	test(`a 400-character token in a title does not widen the detail page on ${label}`, async ({
		page
	}) => {
		await page.setViewportSize(viewport);
		await page.goto(issuePath(projectName, blobIssue.number));
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

		// Was 4773px of document in 390px, 4917px in 1440px.
		expect(await overflow(page)).toBe(0);
	});

	test(`the activity feed survives a long title on ${label}`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await page.goto(`/activity?project=${encodeURIComponent(projectName)}`);
		await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
		// The feed echoes the title on the issue.created row.
		await expect(page.getByText(BLOB_TITLE.slice(0, 60), { exact: false }).first()).toBeVisible();

		// Was 2937px on the phone, 3081px on the desktop.
		expect(await overflow(page)).toBe(0);
	});
}

test('the duplicate-of banner wraps the title it echoes', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(issuePath(projectName, dupIssue.number));
	await expect(page.getByRole('button', { name: 'Not a duplicate?' })).toBeVisible();

	expect(await overflow(page)).toBe(0);
});

test('the linked-issue row truncates the title instead of widening the column', async ({
	page
}) => {
	await page.setViewportSize(PHONE);
	await gotoHydrated(page, issuePath(projectName, dupIssue.number));
	// The Relations card folds to one row on a phone (Tines/165); open it.
	const fold = page.getByRole('button', { name: /^Relations\b/ });
	await expect(async () => {
		if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
		expect(await fold.getAttribute('aria-expanded')).toBe('true');
	}).toPass({ timeout: 15_000 });

	// The sidebar is what carried the overflow: its "Duplicate of" row prints
	// the linked title with `truncate`, whose nowrap set the grid column's
	// min-content floor. It must ellipsise, not shrink to nothing.
	const title = page.locator('#relations span.truncate').first();
	await expect(title).toBeVisible();
	const box = await title.boundingBox();
	expect(box!.width).toBeGreaterThan(100);
	expect(box!.width).toBeLessThan(PHONE.width);
});

test('the heading wraps rather than being clipped away', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(issuePath(projectName, blobIssue.number));

	const heading = page.getByRole('heading', { level: 1 });
	await expect(heading).toBeVisible();
	const box = await heading.boundingBox();
	expect(box).not.toBeNull();

	// Fits the viewport, and the token is laid out over many lines instead of
	// being hidden: a 400-character token at text-2xl needs well over one.
	// (Unfixed it was 96px — three lines, broken only at the two spaces.)
	expect(box!.width).toBeLessThanOrEqual(PHONE.width);
	expect(box!.height).toBeGreaterThan(200);
	expect(await heading.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);

	// The edit affordance stays on screen next to it.
	await expect(page.getByRole('button', { name: 'Edit title' })).toBeInViewport();
});
