import { expect, test } from '@playwright/test';
import { gotoHydrated } from './helpers';

test('renders the complete public story and shares one sign-in dialog', async ({ page }) => {
	await gotoHydrated(page, '/');
	await expect(page.getByRole('heading', { name: /Manage a system/ })).toBeVisible();
	await expect(page.getByLabel('Engineering workflow')).toContainText('Backlog');
	await expect(page.getByLabel('Engineering workflow')).toContainText('Closed');
	await page.getByRole('button', { name: 'Sign in ↗' }).first().click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toBeHidden();
	await page.getByRole('button', { name: 'Sign in ↗' }).last().click();
	await expect(page.getByRole('dialog')).toBeVisible();
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
