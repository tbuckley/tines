import { expect, test } from './fixtures';
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

test('uses native validation without sending an invalid magic-link request', async ({ page }) => {
	let posts = 0;
	page.on('request', (request) => {
		if (request.method() === 'POST' && request.url().includes('/api/auth/')) posts += 1;
	});
	await gotoHydrated(page, '/');
	await page.getByRole('button', { name: 'Sign in ↗' }).first().click();
	await page.getByPlaceholder('you@example.com').fill('not-an-email');
	await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
	await expect(page.getByPlaceholder('you@example.com')).toBeFocused();
	expect(posts).toBe(0);
});

test('ignores a delayed auth completion after close and reopen', async ({ page }) => {
	let release: (() => void) | undefined;
	const delayed = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/api/auth/**', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		await delayed;
		await route.fulfill({
			status: 400,
			contentType: 'application/json',
			body: '{"message":"stale failure"}'
		});
	});
	await gotoHydrated(page, '/');
	const opener = page.getByRole('button', { name: 'Sign in ↗' }).first();
	await opener.click();
	await page.getByPlaceholder('you@example.com').fill('delayed@example.com');
	await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
	await expect(page.getByText('Preparing your sign-in link…')).toBeVisible();
	await page.getByRole('button', { name: 'Close sign-in' }).click();
	await opener.click();
	await expect(page.getByText('Preparing your sign-in link…')).toBeHidden();
	const staleResponse = page.waitForResponse(
		(response) => response.request().method() === 'POST' && response.url().includes('/api/auth/')
	);
	release?.();
	await staleResponse;
	// Give the auth promise a turn to process the released response before
	// asserting absence; an immediate hidden assertion can pass before it settles.
	await page.waitForTimeout(100);
	await expect(page.getByText('stale failure')).toHaveCount(0);
	await expect(page.getByRole('dialog')).toBeVisible();
});

test('enters terminal still mode after WebGL context loss', async ({ page }) => {
	await gotoHydrated(page, '/');
	await expect(page.locator('#stage canvas')).toHaveCount(1);
	await page.locator('#stage canvas').evaluate((canvas) => {
		canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
	});
	await expect(page.locator('#stage canvas')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Still office' })).toBeDisabled();
	await expect(page.locator('#still')).toBeVisible();
});

test('resets motion when the reduced-motion preference changes', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await gotoHydrated(page, '/');
	const motion = page.locator('#motion');
	await expect(motion).toHaveText('Resume motion');
	await motion.click();
	await expect(motion).toHaveText('Pause motion');
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	// The first override has no visible state change to await. Give its media-query
	// event time to dispatch before sending the second CDP override.
	await page.waitForTimeout(500);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(motion).toHaveText('Resume motion');
});

test('sends the Google provider payload and recovers from failure', async ({ page }) => {
	let payload: unknown;
	await page.route('**/api/auth/**', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		payload = route.request().postDataJSON();
		await route.fulfill({
			status: 500,
			contentType: 'application/json',
			body: '{"message":"provider unavailable"}'
		});
	});
	await gotoHydrated(page, '/');
	await page.getByRole('button', { name: 'Sign in ↗' }).first().click();
	await page.getByRole('button', { name: 'Continue with Google' }).click();
	await expect(page.getByRole('status')).toHaveText('provider unavailable');
	expect(payload).toMatchObject({ provider: 'google', callbackURL: '/issues' });
	await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
});
