import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { signIn } from './helpers';

/**
 * The settings chrome: one tab row shared by the four settings pages, and the
 * avatar menu that must list the same four. Export / import was linked from
 * the menu once and a stale-branch merge overwrote the entry in place; nothing
 * asserted the menu, so it passed CI. These tests are that guard.
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

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

/** Click that survives the SSR-to-hydration window (see ui.spec.ts). */
async function clickUntil(button: Locator, done: () => Promise<void>): Promise<void> {
	await expect(async () => {
		if (await button.isVisible()) await button.click();
		await done();
	}).toPass({ timeout: 15_000 });
}

/** The settings tab row; scoped by name because its links share names with page headings. */
const nav = (page: Page) => page.getByRole('navigation', { name: 'Settings' });

test.describe('settings navigation', () => {
	test('the avatar menu lists the four settings pages, Export / import included', async ({
		page
	}) => {
		await page.goto('/issues');
		const menu = page.getByRole('menu');
		await clickUntil(page.getByRole('button', { name: 'Account menu' }), async () => {
			await expect(menu).toBeVisible({ timeout: 1000 });
		});

		// Each item carries an icon, so its text content is ` Appearance`; compare trimmed.
		await expect
			.poll(async () => (await menu.getByRole('menuitem').allTextContents()).map((t) => t.trim()))
			.toEqual([...TABS, 'Sign out']);

		await menu.getByRole('menuitem', { name: 'Export / import' }).click();
		await expect(page).toHaveURL('/settings/export-import');
		await expect(page.getByRole('heading', { name: 'Export / import' })).toBeVisible();
	});

	test('the tab row hops between settings pages and marks the current one', async ({ page }) => {
		await page.goto('/settings/api-keys');
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
		const oneRow = await pill.boundingBox();
		expect(oneRow).not.toBeNull();
		// One row at 390: 3px padding + a 28px tab + 3px + borders.
		expect(oneRow!.height).toBeLessThan(40);
		expect(await pill.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		const mainBox = (await main.boundingBox())!;
		expect(oneRow!.x + oneRow!.width).toBeLessThanOrEqual(mainBox.x + mainBox.width + 1);
		for (const label of TABS) {
			await expect(nav(page).getByRole('link', { name: label })).toBeInViewport({ ratio: 1 });
		}

		// Narrower than the row: it folds to a second line, nothing is clipped
		// and nothing pushes the page into a horizontal scroll.
		await page.setViewportSize(NARROW);
		const wrapped = await pill.boundingBox();
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
		const box = (await pill.boundingBox())!;
		expect(box.width).toBeLessThan(400);
	});
});
