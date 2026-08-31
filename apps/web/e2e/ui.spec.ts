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

test('an issue can be created from the issues list, picking project and starting state', async ({ page }) => {
	await page.goto('/issues');
	const dialog = page.getByRole('dialog', { name: 'New issue' });
	await clickUntil(page.getByRole('button', { name: /New issue/ }), async () => {
		await expect(dialog).toBeVisible({ timeout: 2_000 });
	});
	await dialog.getByLabel('Project', { exact: true }).selectOption({ label: projectName });
	await dialog.getByLabel('Title').fill(`From the list ${runId}`);
	await dialog.getByLabel('Starting state').selectOption({ label: 'Human Review' });
	await dialog.getByRole('button', { name: 'Create issue' }).click();

	// Lands on the new issue's detail page, already in the chosen state.
	await expect(page).toHaveURL(new RegExp(`/issues/${projectName}/\\d+$`));
	await expect(page.getByRole('heading', { name: `From the list ${runId}` })).toBeVisible();
	await expect(stateBadge(page)).toHaveText(/Human Review/);
});

test('the issues list search box round-trips through the q URL param', async ({ page }) => {
	await page.goto('/issues');
	const box = page.getByLabel('Search issues');

	// The submit is a Svelte listener, so retry across the hydration window.
	const searchFor = (term: string, expected: RegExp) =>
		expect(async () => {
			await box.fill(term);
			await box.press('Enter');
			await expect(page).toHaveURL(expected, { timeout: 2_000 });
		}).toPass({ timeout: 15_000 });

	await searchFor(issueTitle, new RegExp(`q=UI(%20|\\+)smoke(%20|\\+)${runId}`));
	await expect(page.getByRole('link', { name: new RegExp(issueTitle) })).toBeVisible();

	// A term nothing matches empties the list, and the box keeps the term.
	await searchFor(`no-such-issue-${runId}`, new RegExp(`q=no-such-issue-${runId}`));
	await expect(page.getByRole('link', { name: new RegExp(issueTitle) })).toBeHidden();
	await expect(box).toHaveValue(`no-such-issue-${runId}`);

	// Clearing it drops the param and brings the issue back.
	await searchFor('', /\/issues\?*$/);
	await expect(page.getByRole('link', { name: new RegExp(issueTitle) })).toBeVisible();
});

test('the mobile layout swaps the header tabs for a bottom bar', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/issues');
	const bottomNav = page.getByRole('navigation', { name: 'Primary' });
	await expect(bottomNav).toBeVisible();
	await expect(bottomNav.getByRole('link', { name: 'Workflows' })).toBeVisible();
	// The desktop tab strip is hidden at this width.
	await expect(page.locator('header').getByRole('link', { name: 'Workflows' })).toBeHidden();
});

test('issue detail renders markdown, transitions, and comments', async ({ page }) => {
	await page.goto(`/issues/${encodeURIComponent(projectName)}/${issue.number}`);

	await expect(page.getByRole('heading', { name: issueTitle })).toBeVisible();
	// Markdown description rendered, not escaped.
	await expect(page.locator('.markdown strong').first()).toHaveText('bold');

	// The state badge starts on the initial state with named actions offered.
	// A transition opens the dialog offering an optional comment, posted
	// atomically (before) with the move.
	await expect(stateBadge(page)).toHaveText(/Open/);
	const transitionDialog = page.getByRole('dialog', { name: /Submit for review/ });
	await clickUntil(page.getByRole('button', { name: /Submit for review/ }).first(), async () => {
		await expect(transitionDialog).toBeVisible({ timeout: 2_000 });
	});
	await transitionDialog.getByLabel(/Comment/).fill('Handing off with feedback');
	await transitionDialog.getByRole('button', { name: 'Submit for review', exact: true }).click();
	await expect(stateBadge(page)).toHaveText(/Human Review/);
	// The allowed actions follow the new state, and the dialog's comment is
	// on the thread.
	await expect(page.getByRole('button', { name: /Approve/ })).toBeVisible();
	await expect(page.getByText('Handing off with feedback')).toBeVisible();

	// Ordering: the comment was posted before the transition, so a dispatch
	// triggered by the move already reads it.
	const api = apiClient(page.request, ALICE.apiKey);
	const comments = await body<{ items: { body: string; created_at: number }[] }>(
		await api.get(`/api/v1/issues/${issue.id}/comments`)
	);
	const posted = comments.items.find((c) => c.body === 'Handing off with feedback');
	expect(posted).toBeDefined();
	const events = await body<{ items: { created_at: number }[] }>(
		await api.get(`/api/v1/events?issue=${issue.id}&type=issue.transitioned`)
	);
	expect(events.items.length).toBeGreaterThanOrEqual(1);
	expect(posted!.created_at).toBeLessThanOrEqual(Math.max(...events.items.map((e) => e.created_at)));

	// Comment round-trip.
	await page.getByPlaceholder(/Leave a comment/).fill('From the browser');
	await clickUntil(page.getByRole('button', { name: 'Comment', exact: true }), async () => {
		await expect(page.getByText('From the browser')).toBeVisible({ timeout: 2_000 });
	});
	await expect(page.getByText(ALICE.name).first()).toBeVisible();

	// The transition shows up in the issue's activity slice. (`exact`: the
	// page now also has an "Agent activity" heading.)
	await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
	await expect(page.getByText(/moved this issue/).first()).toBeVisible();
});

test('issue detail picks up comments and transitions made elsewhere, without a reload', async ({
	page
}) => {
	await page.goto(`/issues/${encodeURIComponent(projectName)}/${issue.number}`);
	await expect(page.getByRole('heading', { name: issueTitle })).toBeVisible();

	// Posted "from outside" the page — via the API, not the browser — so this
	// only passes if the page's background poll notices the new event and
	// resyncs. The test never calls page.reload().
	const api = apiClient(page.request, ALICE.apiKey);
	// 15s timeout: detection can take a full 5s poll cycle plus an
	// invalidateAll reload against wrangler-dev D1 — 8s flaked on slow CI.
	await api.post(`/api/v1/issues/${issue.id}/comments`, { body: 'Landed from elsewhere' });
	await expect(page.getByText('Landed from elsewhere')).toBeVisible({ timeout: 15_000 });

	// Same for a transition made via the API: the state badge should follow.
	const detail = await body<IssueDetail>(await api.get(`/api/v1/issues/${issue.id}`));
	const next = detail.workflow.transitions.find((t) => t.from_state_id === detail.state.id);
	expect(next).toBeDefined();
	const toState = detail.workflow.states.find((s) => s.id === next!.to_state_id);
	expect(toState).toBeDefined();
	await api.post(`/api/v1/issues/${issue.id}/transition`, { transition_id: next!.id });
	await expect(stateBadge(page)).toContainText(toState!.name, { timeout: 15_000 });
});

test('a comment can be edited and deleted from the issue page', async ({ page }) => {
	const api = apiClient(page.request, ALICE.apiKey);
	const created = await body<{ id: string }>(
		await api.post(`/api/v1/issues/${issue.id}/comments`, { body: 'Typpo here' })
	);
	await page.goto(`/issues/${encodeURIComponent(projectName)}/${issue.number}`);
	const comment = page.locator('article').filter({ hasText: 'Typpo here' }).first();
	await expect(comment).toBeVisible();

	await comment.getByRole('button', { name: 'Edit comment' }).click();
	const draft = comment.getByRole('textbox');
	await draft.fill('Typo fixed');
	await comment.getByRole('button', { name: 'Save', exact: true }).click();

	const edited = page.locator('article').filter({ hasText: 'Typo fixed' }).first();
	await expect(edited).toBeVisible({ timeout: 10_000 });
	await expect(edited.getByText('(edited)')).toBeVisible();
	await expect(page.getByText('Typpo here')).toBeHidden();

	// Delete goes through the shared confirm dialog.
	await edited.getByRole('button', { name: 'Delete comment' }).click();
	await page.getByRole('button', { name: 'Delete comment', exact: true }).last().click();
	await expect(page.getByText('Typo fixed')).toHaveCount(0, { timeout: 10_000 });

	// The events survive the comment.
	const events = await body<{ items: { type: string; payload: Record<string, unknown> }[] }>(
		await api.get(`/api/v1/events?issue=${issue.id}`)
	);
	const types = events.items.map((e) => e.type);
	expect(types).toContain('issue.comment_edited');
	expect(types).toContain('issue.comment_deleted');
	expect(
		events.items.find((e) => e.type === 'issue.comment_deleted')?.payload.comment_id
	).toBe(created.id);
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
