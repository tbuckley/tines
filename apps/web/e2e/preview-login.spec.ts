import { expect, test } from '@playwright/test';
import { PREVIEW_LOGIN_TOKEN } from './constants.mjs';

// /api/preview-login (lib/server/preview-login.ts): the e2e build compiles it
// in, as a PR preview build does, and server.sh sets its token.

test('preview login signs in as the fixed probe user', async ({ page }) => {
	const res = await page.request.post('/api/preview-login', {
		headers: { authorization: `Bearer ${PREVIEW_LOGIN_TOKEN}` }
	});
	expect(res.status()).toBe(200);
	const body = await res.json();
	expect(body.user.email).toBe('preview-probe@tines.invalid');
	expect(body.cookie.name).toContain('session_token');

	// page.request shares the page's cookie jar, so the Set-Cookie above
	// already signed the browser in.
	await page.goto('/issues');
	await expect(page).toHaveURL(/\/issues/);
	await expect(page.getByRole('button', { name: 'Account menu' })).toHaveText('PP');

	// A second call reuses the same user rather than creating another.
	const again = await page.request.post('/api/preview-login', {
		headers: { authorization: `Bearer ${PREVIEW_LOGIN_TOKEN}` }
	});
	expect((await again.json()).user.id).toBe(body.user.id);
});

test('preview login refuses a wrong token', async ({ request }) => {
	const res = await request.post('/api/preview-login', {
		headers: { authorization: 'Bearer not-the-token-not-the-token-not-the' }
	});
	expect(res.status()).toBe(401);
});
