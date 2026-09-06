import { expect, test } from '@playwright/test';
import { gotoHydrated, runId } from './helpers';

// The landing-page magic-link form, end to end through the better-auth
// endpoint and the (locally simulated) Email Service binding. The retry loop
// mirrors clickUntil in helpers.ts: a submit landing before hydration is
// swallowed, so re-fill and re-click until the sent state renders.

test('requests a sign-in link from the landing page', async ({ page }) => {
	const email = `magic-${runId}@example.com`;
	await gotoHydrated(page, '/');
	await expect(async () => {
		await page.getByPlaceholder('you@example.com').fill(email);
		await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
		await expect(page.getByText('Check your email')).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 15000 });
	await expect(page.getByText(email)).toBeVisible();
});

test('shows an error when a sign-in link is invalid', async ({ page }) => {
	const res = await page.goto(
		'/api/auth/magic-link/verify?token=not-a-real-token&callbackURL=%2Fissues&errorCallbackURL=%2F'
	);
	expect(res?.url()).toContain('error=');
	await expect(
		page.getByText('That sign-in link is invalid or has expired', { exact: false })
	).toBeVisible();
});
