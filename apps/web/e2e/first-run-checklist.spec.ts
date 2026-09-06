/**
 * The first-run walk (Tines/253): a brand-new account goes from nothing to a
 * running agent entirely through the checklist's own controls — create an
 * issue, register a runner, route work to it, turn automation on — and the
 * last item becomes the run row when the run lands, with no reload anywhere.
 *
 * Runs as DANA, who exists for exactly this: no project, no runner, no rule,
 * automation off, and — the precondition the whole file rests on — no agent
 * run. The checklist is derived from that last fact and retires account-wide
 * the moment a run exists, so **this file is one-way**: it leaves Dana with a
 * run and no other spec may depend on her being run-free. New cases here go
 * after the walk, and the retirement case at the end is what pins the
 * steady-state card (the plain explainer with its `action` links) now that
 * `issue-explainer-remedies.spec.ts` sees the checklist instead.
 *
 * Serial by necessity: each step is the next state of one account.
 */
import { expect, test, type Page } from '@playwright/test';
import type { IssueDetail, ListResponse, Project, RoutingRule } from '@tines/shared';
import { DANA } from './constants.mjs';
import { spawnDaemon, type Daemon } from './daemon';
import { apiClient, body, gotoHydrated, runId, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });

const PROJECT_NAME = `walk-${runId}`;
const RUNNER_NAME = `dana-${runId}`;

let daemon: Daemon | null = null;
let issueNumber: number;
let secondIssueNumber: number;

const checklistOf = (page: Page) => page.getByRole('region', { name: 'First run checklist' });
const item = (page: Page, id: string) => checklistOf(page).locator(`li[data-item="${id}"]`);
const issuePath = (n: number) => `/issues/${encodeURIComponent(PROJECT_NAME)}/${n}`;

test.beforeAll(async ({ request }) => {
	const api = apiClient(request, DANA.apiKey);
	const runs = await body<ListResponse<unknown>>(await api.get('/api/v1/runs'));
	expect(
		runs.items.length,
		'Dana must have no agent runs — this spec walks her to her first one, so re-running it against a reused server fails here. Restart e2e/server.sh to reseed.'
	).toBe(0);
});

// Every test drives the UI as Dana; Playwright hands each one a fresh browser
// context, so the session cookie has to be planted per test, not once.
test.beforeEach(async ({ context }) => {
	await signIn(context, DANA.sessionToken);
});

test.afterAll(async ({ request }) => {
	daemon?.kill();
	// Leave automation off for anything that follows.
	await apiClient(request, DANA.apiKey).put('/api/v1/supervisor/settings', { enabled: false });
});

test('the Agents tab opens on the checklist, not the off-state banner', async ({ page }) => {
	await gotoHydrated(page, '/agents');

	const checklist = checklistOf(page);
	await expect(checklist).toBeVisible();
	await expect(checklist.getByRole('listitem')).toHaveCount(7);
	// The checklist replaces the amber banner outright.
	await expect(page.getByText('Automation is off')).toHaveCount(0);

	// With no project at all, item 1 is the project step and links at the
	// dialog `/projects?new=1` opens.
	await expect(item(page, 'issue')).toHaveAttribute('data-done', 'false');
	await checklist.getByRole('link', { name: 'Create a project' }).click();
	await expect(page).toHaveURL('/projects');
	await expect(page.getByRole('dialog')).toBeVisible();
});

test('creating an issue ticks item 1 on both surfaces without a reload', async ({
	page,
	request
}) => {
	const api = apiClient(request, DANA.apiKey);
	await body<Project>(await api.post('/api/v1/projects', { name: PROJECT_NAME }));

	await gotoHydrated(page, '/agents');
	// With a project and no issue, the same item offers the issue dialog.
	await item(page, 'issue').getByRole('button', { name: 'Create an issue' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByLabel('Title').fill('First run');
	await dialog.getByRole('button', { name: /create/i }).click();

	// The modal navigates client-side to the new issue, whose checklist is the
	// same component with item 1 already ticked — no reload.
	await expect(page).toHaveURL(/\/issues\/.+\/\d+$/);
	issueNumber = Number(new URL(page.url()).pathname.split('/').pop());
	await expect(item(page, 'issue')).toHaveAttribute('data-done', 'true');

	await gotoHydrated(page, '/agents');
	await expect(item(page, 'issue')).toHaveAttribute('data-done', 'true');
});

test('the issue card offers the content items, and neither one blocks', async ({ page }) => {
	await gotoHydrated(page, issuePath(issueNumber));
	const checklist = checklistOf(page);
	await expect(checklist).toBeVisible();

	// The repo hint is optional and is offered while the project has none.
	await checklist.getByRole('button', { name: 'Give the project a repo' }).click();
	const repoDialog = page.getByRole('dialog');
	await expect(repoDialog).toBeVisible();
	await expect(repoDialog.locator('input[name="kind"][value="repo"]')).toBeChecked();
	await page.keyboard.press('Escape');
	await expect(repoDialog).toBeHidden();

	// A description ticks item 6 — the only content item that does.
	await checklist.getByRole('button', { name: 'Add a description' }).click();
	const editor = page.getByRole('textbox', { name: /description/i });
	await expect(editor).toBeFocused();
	await editor.fill('Work out what the first run should do.');
	await page.getByRole('button', { name: /^save/i }).click();
	await expect(item(page, 'content')).toHaveAttribute('data-done', 'true');

	// Optional means optional: the repo is still missing and progress counts on.
	await expect(page.getByTestId('first-run-progress')).toContainText('of 7');
});

test('at 390 px the fold is open on the checklist, with progress in its summary', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await gotoHydrated(page, issuePath(issueNumber));
	// The card's phone fold renders closed by default; while the checklist
	// shows it is bound open, so the items are reachable without a tap.
	await expect(checklistOf(page)).toBeVisible();
	await expect(page.getByText(/first run · \d of 7/)).toBeVisible();
	await page.setViewportSize({ width: 1280, height: 800 });
});

test('a registering daemon ticks the runner and CLI items live', async ({ page }) => {
	await gotoHydrated(page, issuePath(issueNumber));
	await expect(item(page, 'runner')).toHaveAttribute('data-done', 'false');

	daemon = spawnDaemon({ apiKey: DANA.apiKey, name: RUNNER_NAME });

	// No reload: the page's 5 s poll watches the newest account event, and
	// `runner.registered` is one.
	await expect(item(page, 'runner')).toHaveAttribute('data-done', 'true', { timeout: 30_000 });
	// Installing the CLI is proved by a runner having registered with it.
	await expect(item(page, 'cli')).toHaveAttribute('data-done', 'true');
});

test('routing and arming tick from the issue card', async ({ page, request }) => {
	const api = apiClient(request, DANA.apiKey);
	await gotoHydrated(page, issuePath(issueNumber));

	// One runner, so the item offers the one-click global rule by name.
	await checklistOf(page)
		.getByRole('button', { name: `Route everything to ${RUNNER_NAME}` })
		.click();
	await expect(item(page, 'rule')).toHaveAttribute('data-done', 'true', { timeout: 15_000 });
	const rules = await body<ListResponse<RoutingRule>>(await api.get('/api/v1/routing-rules'));
	expect(rules.items).toHaveLength(1);

	await checklistOf(page).getByRole('button', { name: 'Turn automation on' }).click();
	await expect(item(page, 'enabled')).toHaveAttribute('data-done', 'true', { timeout: 15_000 });
	const settings = await body<{ enabled: boolean }>(await api.get('/api/v1/supervisor/settings'));
	expect(settings.enabled).toBe(true);
});

test('the last item becomes the run row when the first run starts', async ({ page }) => {
	// The issue was created in "Open", which is an active state, so arming was
	// the last thing dispatch was waiting for.
	await gotoHydrated(page, issuePath(issueNumber));
	await expect(checklistOf(page).getByText(/Your first run has (started|run) on/)).toBeVisible({
		timeout: 60_000
	});
	await expect(item(page, 'run')).toHaveAttribute('data-done', 'true');

	// The same item on the Agents tab carries the run row, labelled with the
	// issue it is on.
	await gotoHydrated(page, '/agents');
	await expect(checklistOf(page).getByText(/Your first run has (started|run) on/)).toBeVisible();
});

test('the checklist retires account-wide once a run exists', async ({ page, request }) => {
	const api = apiClient(request, DANA.apiKey);
	const project = (await body<ListResponse<Project>>(await api.get('/api/v1/projects'))).items.find(
		(p) => p.name === PROJECT_NAME
	)!;
	const second = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, { title: 'Second issue' })
	);
	secondIssueNumber = second.number;

	// A fresh load past the first run: no checklist anywhere, and the card is
	// back to the steady-state explainer with its remedy links (Tines/252).
	await page.goto(issuePath(secondIssueNumber));
	await expect(checklistOf(page)).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Why?' })).toBeVisible();

	await page.goto('/agents');
	await expect(checklistOf(page)).toHaveCount(0);
});
