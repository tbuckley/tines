import { expect, test } from '@playwright/test';
import { gotoHydrated } from './helpers';

test('renders the complete public story and shares one sign-in dialog', async ({ page }) => {
	await gotoHydrated(page, '/');
	await expect(page.getByRole('heading', { name: /Manage a system/ })).toBeVisible();
	await expect(page.getByLabel('Engineering workflow')).toContainText('Backlog');
	await expect(page.getByLabel('Engineering workflow')).toContainText('Closed');
	await page.getByRole('button', { name: 'Sign in ↗' }).first().click();
	await expect(page.getByRole('dialog')).toBeVisible();
	const centered = await page.getByRole('dialog').evaluate((dialog) => {
		const rect = dialog.getBoundingClientRect();
		return {
			x: Math.abs(rect.left + rect.width / 2 - innerWidth / 2),
			y: Math.abs(rect.top + rect.height / 2 - innerHeight / 2)
		};
	});
	expect(centered.x).toBeLessThan(2);
	expect(centered.y).toBeLessThan(2);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toBeHidden();
	await page.getByRole('button', { name: 'Sign in ↗' }).last().click();
	await expect(page.getByRole('dialog')).toBeVisible();
});

test('keeps fallback choreography when the lazy scene chunk fails', async ({ page }) => {
	await page.route('**/_app/immutable/chunks/*.js', async (route) => {
		const response = await route.fetch();
		const body = await response.body();
		if (body.includes(Buffer.from('createOfficeScene'))) await route.abort();
		else await route.fulfill({ response, body });
	});
	await gotoHydrated(page, '/');
	await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
	await expect(page.locator('.marketing-page')).toHaveAttribute('data-phase', 'Closed');
	await expect(page.locator('#still')).toHaveAttribute('src', /office-4\.png$/);
	await page.getByRole('button', { name: 'Sign in ↗' }).last().click();
	await expect(page.getByRole('dialog')).toBeVisible();
});

test('destroys and recreates exactly one scene canvas across navigation', async ({ page }) => {
	await gotoHydrated(page, '/');
	await expect(page.locator('#stage canvas')).toHaveCount(1);
	await page.goto('/api/auth/get-session');
	await expect(page.locator('#stage canvas')).toHaveCount(0);
	await gotoHydrated(page, '/');
	await expect(page.locator('#stage canvas')).toHaveCount(1);
});

test('keeps the approved landing palette when dark mode is saved', async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
	await gotoHydrated(page, '/');
	await expect(page.locator('.marketing-page')).toHaveCSS('background-color', 'rgb(215, 225, 227)');
});

test('falls back to a still office when WebGL is unavailable', async ({ page }) => {
	await page.addInitScript(() => {
		HTMLCanvasElement.prototype.getContext = () => null;
	});
	await gotoHydrated(page, '/');
	await expect(page.getByRole('button', { name: 'Still office' })).toBeDisabled();
	await expect(page.locator('#still')).toBeVisible();
	await page.getByRole('button', { name: 'Sign in ↗' }).first().click();
	await expect(page.getByRole('dialog')).toBeVisible();
});
