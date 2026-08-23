import type { IssueDetail, Project } from '@tines/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, runId, signIn } from './helpers';

// Browser flows, signed in as the seeded user via a signed session cookie.
// Names carry the per-run suffix so re-runs against a reused server stay
// unambiguous.

const projectName = `ui-${runId}`;
const issueTitle = `UI smoke ${runId}`;
let project: Project;
let issue: IssueDetail;

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({
		baseURL: test.info().project.use.baseURL
	});
	const api = apiClient(request, ALICE.apiKey);
	project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
	issue = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, {
			title: issueTitle,
			description: 'A **bold** claim.'
		})
	);
	await request.dispose();
});

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

/**
 * Click that survives the SSR-to-hydration window: a click landing before
 * the listeners attach is swallowed, so retry until `done` holds.
 */
async function clickUntil(button: Locator, done: () => Promise<void>): Promise<void> {
	await expect(async () => {
		if (await button.isVisible()) await button.click();
		await done();
	}).toPass({ timeout: 15_000 });
}

const stateBadge = (page: Page) => page.locator('.state-badge').first();

test('a signed-in visit to / lands on the issues list', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/issues$/);
	await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
	await expect(page.getByRole('link', { name: new RegExp(issueTitle) })).toBeVisible();
});

test('issue detail renders markdown, transitions, and comments', async ({ page }) => {
	await page.goto(`/issues/${encodeURIComponent(projectName)}/${issue.number}`);

	await expect(page.getByRole('heading', { name: issueTitle })).toBeVisible();
	// Markdown description rendered, not escaped.
	await expect(page.locator('.markdown strong').first()).toHaveText('bold');

	// The state badge starts on the initial state with named actions offered.
	await expect(stateBadge(page)).toHaveText(/Open/);
	await clickUntil(page.getByRole('button', { name: /Submit for review/ }), async () => {
		await expect(stateBadge(page)).toHaveText(/Human Review/, { timeout: 2_000 });
	});
	// The allowed actions follow the new state.
	await expect(page.getByRole('button', { name: /Approve/ })).toBeVisible();

	// Comment round-trip.
	await page.getByPlaceholder(/Leave a comment/).fill('From the browser');
	await clickUntil(page.getByRole('button', { name: 'Comment', exact: true }), async () => {
		await expect(page.getByText('From the browser')).toBeVisible({ timeout: 2_000 });
	});
	await expect(page.getByText(ALICE.name).first()).toBeVisible();

	// The transition shows up in the issue's activity slice.
	await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
	await expect(page.getByText(/moved this issue/).first()).toBeVisible();
});

test('workflow library shows the read-only standard workflow with its graph', async ({ page }) => {
	await page.goto('/workflows');
	const link = page.getByRole('link', { name: /Standard/ }).first();
	await link.click();
	await expect(page).toHaveURL(/\/workflows\/wf_/);

	await expect(page.getByText('standard · read-only')).toBeVisible();
	const graph = page.locator('svg[aria-label="Workflow graph"]').first();
	await expect(graph).toBeVisible();
	for (const state of ['Open', 'Human Review', 'Closed']) {
		await expect(graph.getByText(state, { exact: true })).toBeVisible();
	}
	// Edge labels carry the action names.
	await expect(graph.getByText('Approve', { exact: true })).toBeVisible();
});

test('a duplicate project name surfaces the API error in the create modal', async ({ page }) => {
	await page.goto('/projects');
	await clickUntil(page.getByRole('button', { name: /New project/ }), async () => {
		await expect(page.getByLabel('Name')).toBeVisible({ timeout: 2_000 });
	});
	await page.getByLabel('Name').fill(projectName);
	await page.getByRole('button', { name: 'Create project' }).click();
	await expect(page.getByText(/already exists/)).toBeVisible();
});
