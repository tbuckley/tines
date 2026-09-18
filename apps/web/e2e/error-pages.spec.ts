import type { Project } from '@tines/shared';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { apiClient, body, gotoHydrated, resetFocus, runId, signIn } from './helpers';

// Every 404 should land on an in-app error page: app chrome intact, a message
// that names what was missing, and a link back to Issues (Tines/44).

let projectName: string;
let project: Project;

test.beforeAll(async ({ apiFor, uniqueName }) => {
	projectName = uniqueName('err');
	const api = apiFor(ALICE);
	project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
});

test.use({ signedIn: ALICE });

test.beforeEach(async ({ request }) => {
	// Specs share one user: a focus left behind would scope this one's lists.
	await resetFocus(request);
});

/**
 * The app header and the phone tab bar both live in (app)/+layout.svelte.
 * The tab bar is `sm:hidden` at desktop width, so it is matched by CSS —
 * getByRole skips display:none elements.
 */
async function expectAppChrome(page: Page) {
	await expect(page.getByRole('banner').getByRole('link', { name: 'Tines' })).toBeVisible();
	await expect(page.locator('nav[aria-label="Primary"]')).toBeAttached();
	await expect(page.getByRole('banner').getByRole('link', { name: 'Issues' })).toBeVisible();
}

const cases = [
	{
		name: 'a URL that matches no route',
		path: () => '/nope',
		message: /There is no page at this address\./
	},
	{
		name: 'an unknown project in an issue URL',
		path: () => '/issues/NoSuchProject/1',
		message: /You have no project named “NoSuchProject”\./
	},
	{
		name: 'an issue number that does not exist',
		path: () => `/issues/${encodeURIComponent(projectName)}/9999`,
		message: /Issue #9999 does not exist/
	},
	{
		name: 'a non-numeric issue number',
		path: () => `/issues/${encodeURIComponent(projectName)}/abc`,
		message: /“abc” is not an issue number\./
	},
	{
		name: 'a negative issue number',
		path: () => `/issues/${encodeURIComponent(projectName)}/-1`,
		message: /“-1” is not an issue number\./
	},
	{
		name: 'an unknown project id',
		path: () => '/projects/prj_doesnotexist',
		message: /No project has the ID “prj_doesnotexist”\./
	},
	{
		name: 'an unknown workflow id',
		path: () => '/workflows/wf_doesnotexist',
		message: /No workflow has the ID “wf_doesnotexist”\./
	}
];

for (const c of cases) {
	test(`${c.name} renders the in-app 404`, async ({ page }) => {
		const response = await page.goto(c.path());
		expect(response?.status()).toBe(404);
		await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
		await expect(page.getByText(c.message)).toBeVisible();
		await expectAppChrome(page);
	});
}

test('the error page links back to Issues', async ({ page }) => {
	await gotoHydrated(page, '/issues/NoSuchProject/1');
	await page.getByRole('link', { name: 'Back to issues' }).click();
	await expect(page).toHaveURL(/\/issues$/);
	await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
});

test('a 404 keeps the error boundary, not a broken shell, in dark mode', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.goto('/nope');
	await expect(page.locator('html')).toHaveClass(/\bdark\b/);
	await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('unknown /api paths stay outside the catch-all page', async ({ request }) => {
	// The notApi matcher keeps the rest parameter away from /api/*, so an API
	// client gets a 404 rather than a redirect into the sign-in page.
	const response = await request.get('/api/v1/no-such-endpoint', { maxRedirects: 0 });
	expect(response.status()).toBe(404);
});

test('a signed-out visitor sees the standalone error page', async ({ browser }) => {
	// No (app) layout in the tree for /api/*, so this exercises the root boundary.
	const context = await browser.newContext();
	const page = await context.newPage();
	const response = await page.goto('/api/v1/no-such-endpoint');
	expect(response?.status()).toBe(404);
	await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Go to sign in' })).toBeVisible();
	await context.close();
});
