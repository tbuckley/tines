import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { clickUntil, gotoHydrated, resetFocus, signIn } from './helpers';

// Theme resolution happens entirely in the browser: a pre-paint script in
// app.html reads localStorage, and $lib/theme.svelte.ts takes over on hydration.

test.use({ signedIn: ALICE });

test.beforeEach(async ({ request }) => {
	// Specs share one user: a focus left behind would scope this one's lists.
	await resetFocus(request);
});

const html = (page: Page) => page.locator('html');

const nativeSelectBackground = (page: Page) =>
	page.evaluate(() => {
		const select = document.createElement('select');
		select.style.all = 'revert';
		select.style.colorScheme = 'inherit';
		document.body.append(select);
		const background = getComputedStyle(select).backgroundColor;
		select.remove();
		return background;
	});

test.describe('with a dark system preference', () => {
	test.use({ colorScheme: 'dark' });

	test('the app is dark by default', async ({ page }) => {
		await page.goto('/issues');
		await expect(html(page)).toHaveClass(/\bdark\b/);
		await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
	});

	test('color-scheme follows the theme, so native controls render dark', async ({ page }) => {
		await page.goto('/settings/appearance');
		await expect(html(page)).toHaveClass(/\bdark\b/);
		const colorScheme = await page.evaluate(
			() => getComputedStyle(document.documentElement).colorScheme
		);
		expect(colorScheme).toBe('dark');
	});

	test('native selects keep the native dark background used by their popup', async ({ page }) => {
		await gotoHydrated(page, '/issues');
		await clickUntil(page.getByRole('button', { name: /^Filter/ }), async () => {
			await expect(page.getByLabel('Filter by workflow')).toBeVisible({ timeout: 2_000 });
		});

		const select = page.getByLabel('Filter by workflow');
		const background = await select.evaluate(
			(element) => getComputedStyle(element).backgroundColor
		);
		expect(background).toBe(await nativeSelectBackground(page));
	});
});

test.describe('with a light system preference', () => {
	test.use({ colorScheme: 'light' });

	test('the app is light by default', async ({ page }) => {
		await page.goto('/issues');
		await expect(html(page)).not.toHaveClass(/\bdark\b/);
	});

	test('native selects keep their transparent light-theme background', async ({ page }) => {
		await gotoHydrated(page, '/issues');
		await clickUntil(page.getByRole('button', { name: /^Filter/ }), async () => {
			await expect(page.getByLabel('Filter by workflow')).toBeVisible({ timeout: 2_000 });
		});

		const background = await page
			.getByLabel('Filter by workflow')
			.evaluate((element) => getComputedStyle(element).backgroundColor);
		expect(background).toBe('rgba(0, 0, 0, 0)');
	});

	test('a dark override persists across a reload and can be handed back to the system', async ({
		page
	}) => {
		await gotoHydrated(page, '/settings/appearance');
		await clickUntil(page.getByTestId('theme-dark'), async () => {
			await expect(html(page)).toHaveClass(/\bdark\b/, { timeout: 2_000 });
		});

		// A reload proves both persistence and the pre-paint script: the class is
		// present in the very first paint, before hydration could add it.
		await page.reload();
		await expect(html(page)).toHaveClass(/\bdark\b/);
		expect(await page.evaluate(() => localStorage.getItem('tines:theme'))).toBe('dark');

		await clickUntil(page.getByTestId('theme-system'), async () => {
			await expect(html(page)).not.toHaveClass(/\bdark\b/, { timeout: 2_000 });
		});
		expect(await page.evaluate(() => localStorage.getItem('tines:theme'))).toBe('system');
	});
});
