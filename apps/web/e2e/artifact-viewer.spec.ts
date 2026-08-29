import type { IssueDetail, Project } from '@tines/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, runId, signIn } from './helpers';

/**
 * The artifact viewer on a phone (Tines/28): a markdown doc far taller than
 * the screen, or a folder of images, used to leave no way out — the modal had
 * no close control, so the only exits were Escape (no keyboard on a phone) and
 * a 16px strip of backdrop. These assert the close button stays on screen
 * whatever the content's height, and that the page behind stays put.
 */

const projectName = `viewer-${runId}`;
let project: Project;
let issue: IssueDetail;

const PHONE = { width: 390, height: 844 };

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({
		baseURL: test.info().project.use.baseURL
	});
	const api = apiClient(request, ALICE.apiKey);
	project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
	issue = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, { title: `Viewer ${runId}` })
	);

	// Far taller than any viewport: ~400 paragraphs of markdown.
	const paragraphs = Array.from(
		{ length: 400 },
		(_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} of a very long document.`
	).join('\n\n');
	await api.put(`/api/v1/issues/${issue.id}/artifacts/long-doc`, {
		type: 'text',
		content: paragraphs,
		content_type: 'text/markdown'
	});

	// A folder set: the gallery has no height cap of its own, so the modal is
	// the only thing keeping it on screen.
	const multipart: Record<string, { name: string; mimeType: string; buffer: Buffer }> =
		Object.fromEntries(
			Array.from({ length: 8 }, (_, i) => [
				`f${i}`,
				{ name: `shot-${i}.png`, mimeType: 'image/png', buffer: Buffer.from(`PNG${i}`) }
			])
		);
	await request.put(`/api/v1/issues/${issue.id}/artifacts/photos/folder`, {
		headers: { authorization: `Bearer ${ALICE.apiKey}` },
		multipart
	});
	// The page behind has to be taller than the phone viewport for the scroll
	// lock assertions below to mean anything.
	await api.post(`/api/v1/issues/${issue.id}/comments`, {
		body: Array.from({ length: 40 }, (_, i) => `Comment paragraph ${i + 1}.`).join('\n\n')
	});

	await request.dispose();
});

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

const issueUrl = () => `/issues/${encodeURIComponent(projectName)}/${issue.number}`;

/**
 * Click that survives the SSR-to-hydration window (same shape as
 * `ui.spec.ts`'s `clickUntil`): a click landing before the listeners attach is
 * swallowed, so retry until the dialog is up.
 */
async function openViewer(opener: Locator, dialog: Locator): Promise<void> {
	await expect(async () => {
		if (await opener.isVisible()) await opener.click();
		await expect(dialog).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 15_000 });
}

test('a long markdown artifact stays dismissable on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(issueUrl());

	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View long-doc/ }), dialog);

	const closeButton = dialog.getByRole('button', { name: 'Close' });
	await expect(closeButton).toBeInViewport();

	// The body is the only scroller; run it to the bottom and the close button
	// is still there (it lives in the non-scrolling header).
	const scroller = dialog.locator('div.overflow-y-auto').first();
	await expect(async () => {
		const scrolledToEnd = await scroller.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
			return el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
		});
		expect(scrolledToEnd).toBe(true);
	}).toPass({ timeout: 10_000 });
	await expect(closeButton).toBeInViewport();

	await closeButton.click();
	await expect(dialog).toBeHidden();
});

test('a folder set stays within the viewport and dismissable on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(issueUrl());

	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View photos/ }).first(), dialog);

	const closeButton = dialog.getByRole('button', { name: 'Close' });
	await expect(closeButton).toBeInViewport();

	// The panel no longer runs off the bottom of the screen.
	const box = await dialog.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height);

	await closeButton.click();
	await expect(dialog).toBeHidden();
});

/**
 * Scroll the page behind the way a user would — a wheel over the backdrop strip
 * at the screen edge — and report where it ended up. Deliberately not
 * `window.scrollTo`: `overflow: hidden` still allows programmatic scrolling, so
 * that would report 400 for a page that no user can move (measured).
 */
async function wheelPageBehind(page: Page): Promise<number> {
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.mouse.move(5, 400);
	await page.mouse.wheel(0, 400);
	await page.waitForTimeout(250);
	return page.evaluate(() => window.scrollY);
}

/** The page behind is long enough that a failure to lock is visible. */
async function expectPageBehindScrolls(page: Page): Promise<void> {
	await expect(async () => {
		expect(await wheelPageBehind(page)).toBeGreaterThan(0);
	}).toPass({ timeout: 10_000 });
}

test('the page behind does not scroll while the viewer is open', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(issueUrl());

	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View long-doc/ }), dialog);

	// Behavioural, not `body.style.overflow === 'hidden'`: any lock that works
	// passes this, and a lock that has been defeated fails it.
	expect(await wheelPageBehind(page)).toBe(0);

	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toBeHidden();
	await expectPageBehindScrolls(page);
});

test('two modals open at once still release the page when both close', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(issueUrl());

	const viewer = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(page.getByRole('button', { name: /^View long-doc/ }), viewer);

	// Focus is moved into the dialog but not trapped, and the background is not
	// inert (Tines/29), so a keyboard user can still reach a trigger behind the
	// overlay and stack a second modal on the first. The scroll lock has to be
	// ref-counted to survive that: per-instance save/restore inverts, and the
	// last close writes 'hidden' back, leaving the whole app unscrollable.
	const attach = page.getByRole('button', { name: 'Attach artifact' });
	await attach.focus();
	await expect(attach).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog', { name: 'Attach artifact' })).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(2);
	expect(await wheelPageBehind(page)).toBe(0);

	// Escape is a `<svelte:window>` handler in every mounted instance, so one
	// press closes both.
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expectPageBehindScrolls(page);
});

test('Escape closes the viewer and returns focus to the button that opened it', async ({ page }) => {
	await page.goto(issueUrl());

	const opener = page.getByRole('button', { name: /^View long-doc/ });
	const dialog = page.getByRole('dialog', { name: 'Artifact viewer' });
	await openViewer(opener, dialog);
	await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();

	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(opener).toBeFocused();
});
