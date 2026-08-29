import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { signIn } from './helpers';

// Theme resolution happens entirely in the browser: a pre-paint script in
// app.html reads localStorage, and $lib/theme.svelte.ts takes over on hydration.

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

const html = (page: Page) => page.locator('html');

/** Click that survives the SSR-to-hydration window (see ui.spec.ts). */
async function clickUntil(button: Locator, done: () => Promise<void>): Promise<void> {
	await expect(async () => {
		if (await button.isVisible()) await button.click();
		await done();
	}).toPass({ timeout: 15_000 });
}

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
});

test.describe('with a light system preference', () => {
	test.use({ colorScheme: 'light' });

	test('the app is light by default', async ({ page }) => {
		await page.goto('/issues');
		await expect(html(page)).not.toHaveClass(/\bdark\b/);
	});

	test('a dark override persists across a reload and can be handed back to the system', async ({
		page
	}) => {
		await page.goto('/settings/appearance');
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
