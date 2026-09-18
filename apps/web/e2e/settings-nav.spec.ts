import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { clickUntil, gotoHydrated, readSettled, resetFocus, signIn } from './helpers';

/**
 * The settings chrome: one tab row shared by the four settings pages, reached
 * from a single Settings entry in the avatar menu. Export / import was linked
 * from the menu once and a stale-branch merge overwrote the entry in place;
 * nothing asserted it, so it passed CI. The tab row is now the only route to
 * those pages, so these tests walk it from the menu.
 */

const PHONE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 568 };
const DESKTOP = { width: 1440, height: 900 };

const TABS = ['Appearance', 'Labels', 'API keys', 'Export / import'];
const PATHS = [
	'/settings/appearance',
	'/settings/labels',
	'/settings/api-keys',
	'/settings/export-import'
];

test.use({ signedIn: ALICE });

test.beforeEach(async ({ request }) => {
	// Specs share one user: a focus left behind would scope this one's lists.
	await resetFocus(request);
});

/** The settings tab row; scoped by name because its links share names with page headings. */
const nav = (page: Page) => page.getByRole('navigation', { name: 'Settings' });

/** Geometry read once it has stopped moving — see the Geometry section of e2e/README.md. */
const box = (target: Locator) => readSettled(() => target.boundingBox(), { timeout: 3_000 });

test.describe('settings navigation', () => {
	test('the avatar menu offers Settings, which lands on the first tab', async ({ page }) => {
		await gotoHydrated(page, '/issues');
		const menu = page.getByRole('menu');
		await clickUntil(page.getByRole('button', { name: 'Account menu' }), async () => {
			await expect(menu).toBeVisible({ timeout: 1000 });
		});

		// One settings entry, not one per page. Each item carries an icon, so its
		// text content is ` Settings`; compare trimmed.
		await expect
			.poll(async () => (await menu.getByRole('menuitem').allTextContents()).map((t) => t.trim()))
			.toEqual(['Settings', 'Sign out']);

		await menu.getByRole('menuitem', { name: 'Settings' }).click();
		await expect(page).toHaveURL('/settings/appearance');
		await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();

		// Export / import has no menu entry of its own: the tab row is how it is found.
		await nav(page).getByRole('link', { name: 'Export / import' }).click();
		await expect(page).toHaveURL('/settings/export-import');
		await expect(page.getByRole('heading', { name: 'Export / import' })).toBeVisible();
	});

	test('the tab row hops between settings pages and marks the current one', async ({ page }) => {
		await gotoHydrated(page, '/settings/api-keys');
		await expect(nav(page).getByRole('link')).toHaveText(TABS);
		await expect(nav(page).getByRole('link', { name: 'API keys' })).toHaveAttribute(
			'aria-current',
			'page'
		);

		await nav(page).getByRole('link', { name: 'Labels' }).click();
		await expect(page).toHaveURL('/settings/labels');
		await expect(nav(page).getByRole('link', { name: 'Labels' })).toHaveAttribute(
			'aria-current',
			'page'
		);
		await expect(nav(page).getByRole('link', { name: 'API keys' })).not.toHaveAttribute(
			'aria-current',
			'page'
		);
		await expect(page.getByRole('heading', { name: 'Labels' })).toBeVisible();
		await expect(page.getByText('Settings', { exact: true })).toBeVisible();
	});

	test('every settings page carries the header, with its own tab current', async ({ page }) => {
		for (const path of PATHS) {
			await page.goto(path);
			await expect(page.getByText('Settings', { exact: true })).toBeVisible();
			await expect(nav(page).getByRole('link')).toHaveText(TABS);
			const current = nav(page).locator('a[aria-current="page"]');
			await expect(current).toHaveCount(1);
			await expect(current).toHaveAttribute('href', path);
		}
	});

	test('/settings lands on the first tab', async ({ page }) => {
		await page.goto('/settings');
		await expect(page).toHaveURL('/settings/appearance');
		await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
	});

	test('the tab row fits a phone and wraps rather than overflowing', async ({ page }) => {
		await page.setViewportSize(PHONE);
		await page.goto('/settings/export-import');

		const pill = nav(page).locator('div').first();
		const main = page.locator('main');
		const oneRow = await box(pill);
		expect(oneRow).not.toBeNull();
		// One row at 390: 3px padding + a 28px tab + 3px + borders.
		expect(oneRow!.height).toBeLessThan(40);
		expect(await pill.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		const mainBox = (await box(main))!;
		expect(oneRow!.x + oneRow!.width).toBeLessThanOrEqual(mainBox.x + mainBox.width + 1);
		for (const label of TABS) {
			await expect(nav(page).getByRole('link', { name: label })).toBeInViewport({ ratio: 1 });
		}

		// Narrower than the row: it folds to a second line, nothing is clipped
		// and nothing pushes the page into a horizontal scroll.
		await page.setViewportSize(NARROW);
		const wrapped = await box(pill);
		expect(wrapped!.height).toBeGreaterThan(50);
		for (const label of TABS) {
			await expect(nav(page).getByRole('link', { name: label })).toBeInViewport({ ratio: 1 });
		}
		expect(await main.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	});

	test('on desktop the pill hugs its tabs instead of stretching', async ({ page }) => {
		await page.setViewportSize(DESKTOP);
		await page.goto('/settings/appearance');
		const pill = nav(page).locator('div').first();
		expect(await pill.evaluate((el) => getComputedStyle(el).display)).toBe('inline-flex');
		const pillBox = (await box(pill))!;
		expect(pillBox.width).toBeLessThan(400);
	});
});
