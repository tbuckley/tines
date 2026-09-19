import type { IssueDetail, Project } from '@tines/shared';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import {
	apiClient,
	body,
	clickToOpen,
	clickUntil,
	gotoHydrated,
	readSettled,
	resetFocus,
	runId,
	signIn
} from './helpers';

// Browser flows, signed in as the seeded user via a signed session cookie.
// Names carry the per-run suffix so re-runs against a reused server stay
// unambiguous.

let projectName: string;
const issueTitle = `UI smoke ${runId}`;
let project: Project;
let longProject: Project;
let issue: IssueDetail;

test.beforeAll(async ({ apiFor, uniqueName }) => {
	projectName = uniqueName('ui');
	const api = apiFor(ALICE);
	project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
	longProject = await body<Project>(
		await api.post('/api/v1/projects', {
			name: `A deliberately long focused project name for chrome ${runId}`
		})
	);
	issue = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, {
			title: issueTitle,
			description: 'A **bold** claim.'
		})
	);
});

test.use({ signedIn: ALICE });

test.beforeEach(async ({ request }) => {
	// Specs share one user: a focus left behind would scope this one's lists.
	await resetFocus(request);
});

const stateBadge = (page: Page) => page.locator('.state-badge').first();

test('the suite runs under reduced motion by default', async ({ page }) => {
	// Guards playwright.config.ts's reducedMotion: 'reduce'. If this fails after
	// a Playwright bump, the context option has stopped reaching the page again
	// (it did not on 1.62.1) and the suite is silently exercising outros.
	await page.goto('/');
	expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
		true
	);
});

test('a signed-in visit to / lands on the issues list', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/issues$/);
	await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
	await expect(page.getByRole('link', { name: new RegExp(issueTitle) })).toBeVisible();
});

test('an issue can be created from the issues list, picking project and starting state', async ({
	page
}) => {
	await gotoHydrated(page, '/issues');
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
	await gotoHydrated(page, '/issues');
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

test('workflow actions fill the phone content and form a compact desktop row', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/workflows');

	const intro = page.getByText('Your library of state machines.');
	const pageIntro = page.getByTestId('workflow-page-intro');
	const actionGroup = page.getByTestId('workflow-actions');
	const actions = [
		page.getByRole('link', { name: 'Public snapshots' }),
		page.getByRole('link', { name: 'Install package' }),
		page.getByRole('link', { name: 'New workflow' })
	];
	await expect(intro).toBeVisible();
	await expect(actions[0]).toBeVisible();

	const introBox = (await intro.boundingBox())!;
	const pageIntroBox = (await pageIntro.boundingBox())!;
	const actionGroupBox = (await actionGroup.boundingBox())!;
	const actionBoxes = await Promise.all(actions.map((action) => action.boundingBox()));
	expect(actionGroupBox.x, 'phone action group left edge').toBeCloseTo(pageIntroBox.x, 0);
	expect(actionGroupBox.width, 'phone action group fills the content width').toBeCloseTo(
		pageIntroBox.width,
		0
	);
	for (const [index, actionBox] of actionBoxes.entries()) {
		expect(actionBox).not.toBeNull();
		expect(actionBox!.y, `action ${index + 1} follows the intro`).toBeGreaterThan(
			introBox.y + introBox.height
		);
		expect(actionBox!.x, `action ${index + 1} left edge`).toBe(actionBoxes[0]!.x);
		expect(actionBox!.width, `phone action ${index + 1} fills the group`).toBeCloseTo(
			actionGroupBox.width,
			0
		);
		expect(
			actionBox!.x + actionBox!.width,
			`action ${index + 1} stays in the viewport`
		).toBeLessThanOrEqual(390);
	}
	for (let index = 1; index < actionBoxes.length; index += 1) {
		expect(actionBoxes[index]!.y, `action ${index + 1} follows action ${index}`).toBeGreaterThan(
			actionBoxes[index - 1]!.y + actionBoxes[index - 1]!.height
		);
	}

	await page.setViewportSize({ width: 1440, height: 900 });
	const desktopPageIntroBox = (await pageIntro.boundingBox())!;
	const desktopActionGroupBox = (await actionGroup.boundingBox())!;
	const desktopActionBoxes = await Promise.all(actions.map((action) => action.boundingBox()));
	for (const [index, actionBox] of desktopActionBoxes.entries()) {
		expect(actionBox).not.toBeNull();
		expect(actionBox!.y, `desktop action ${index + 1} shares one row`).toBeCloseTo(
			desktopActionBoxes[0]!.y,
			0
		);
		expect(
			actionBox!.width,
			`desktop action ${index + 1} does not span the action region`
		).toBeLessThan(desktopActionGroupBox.width / 2);
	}
	expect(
		desktopActionGroupBox.x + desktopActionGroupBox.width,
		'desktop action row is right-aligned'
	).toBeCloseTo(desktopPageIntroBox.x + desktopPageIntroBox.width, 0);
});

test('the app chrome stays inside both responsive breakpoint boundaries', async ({ page }) => {
	const api = apiClient(page.request, ALICE.apiKey);
	await body(await api.patch('/api/v1/preferences', { focused_project_id: longProject.id }));
	await page.setViewportSize({ width: 639, height: 844 });
	await gotoHydrated(page, '/issues');

	const header = page.locator('header');
	const switcher = header.getByRole('button', { name: /^Project focus:/ });
	const account = header.getByRole('button', { name: 'Account menu' });
	const headerWorkflows = header.getByRole('link', { name: 'Workflows' });
	const bottomNav = page.getByRole('navigation', { name: 'Primary' });
	await expect(switcher).toBeVisible();

	for (const width of [639, 640, 641, 767, 768, 769]) {
		await page.setViewportSize({ width, height: 844 });
		const geometry = await readSettled(() =>
			page.evaluate(() => {
				const switcher = document.querySelector<HTMLElement>(
					'button[aria-label^="Project focus:"]'
				)!;
				const account = document.querySelector<HTMLElement>('button[aria-label="Account menu"]')!;
				const headerNav = document.querySelector<HTMLElement>('header nav')!;
				const box = (element: HTMLElement) => {
					const bounds = element.getBoundingClientRect();
					return { left: bounds.left, right: bounds.right };
				};
				return {
					overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
					switcher: box(switcher),
					switcherScrollWidth: switcher.scrollWidth,
					switcherClientWidth: switcher.clientWidth,
					account: box(account),
					headerNav: getComputedStyle(headerNav).display === 'none' ? null : box(headerNav)
				};
			})
		);

		expect(geometry.overflow, `document overflow at ${width}px`).toBe(0);
		expect(geometry.switcher.left, `switcher left edge at ${width}px`).toBeGreaterThanOrEqual(0);
		expect(geometry.switcher.right, `switcher right edge at ${width}px`).toBeLessThanOrEqual(width);
		expect(geometry.switcherScrollWidth, `switcher contents at ${width}px`).toBeLessThanOrEqual(
			geometry.switcherClientWidth
		);
		expect(geometry.account.right, `account right edge at ${width}px`).toBeLessThanOrEqual(width);
		expect(geometry.switcher.right, `switcher/account overlap at ${width}px`).toBeLessThanOrEqual(
			geometry.account.left
		);
		if (width < 768) {
			await expect(bottomNav).toBeVisible();
			await expect(headerWorkflows).toBeHidden();
			expect(geometry.headerNav).toBeNull();
		} else {
			await expect(bottomNav).toBeHidden();
			await expect(headerWorkflows).toBeVisible();
			expect(
				geometry.headerNav!.left,
				`switcher/navigation overlap at ${width}px`
			).toBeGreaterThanOrEqual(geometry.switcher.right);
			expect(
				geometry.headerNav!.right,
				`navigation/account overlap at ${width}px`
			).toBeLessThanOrEqual(geometry.account.left);
		}
	}

	for (const width of [640, 768]) {
		await page.setViewportSize({ width, height: 844 });
		const focusMenu = page.getByRole('menu', { name: 'Project focus' });
		await clickToOpen(switcher, focusMenu);
		await expect(focusMenu.getByRole('menuitemradio', { name: 'All projects' })).toBeVisible();
		expect((await focusMenu.boundingBox())!.x).toBeGreaterThanOrEqual(0);
		expect(
			(await focusMenu.boundingBox())!.x + (await focusMenu.boundingBox())!.width
		).toBeLessThanOrEqual(width);
		await page.keyboard.press('Escape');

		const accountMenu = page
			.getByRole('menu')
			.filter({ has: page.getByRole('menuitem', { name: 'Settings' }) });
		await clickToOpen(account, accountMenu);
		await expect(accountMenu.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
		const accountMenuBox = (await accountMenu.boundingBox())!;
		expect(accountMenuBox.x).toBeGreaterThanOrEqual(0);
		expect(accountMenuBox.x + accountMenuBox.width).toBeLessThanOrEqual(width);
		await page.keyboard.press('Escape');
	}
});

test('issue detail renders markdown, transitions, and comments', async ({ page }) => {
	await gotoHydrated(page, `/issues/${encodeURIComponent(projectName)}/${issue.number}`);

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
	expect(posted!.created_at).toBeLessThanOrEqual(
		Math.max(...events.items.map((e) => e.created_at))
	);

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
	await gotoHydrated(page, `/issues/${encodeURIComponent(projectName)}/${issue.number}`);
	const comment = page.locator('article').filter({ hasText: 'Typpo here' }).first();
	await expect(comment).toBeVisible();

	// Editing swaps the rendered body for a textarea, so the article stops
	// matching on its text: address it by the Save button instead.
	const editing = page
		.locator('article')
		.filter({ has: page.getByRole('button', { name: 'Save', exact: true }) });
	await clickUntil(comment.getByRole('button', { name: 'Edit comment' }), async () => {
		await expect(editing).toBeVisible({ timeout: 2_000 });
	});
	await editing.getByRole('textbox').fill('Typo fixed');
	await editing.getByRole('button', { name: 'Save', exact: true }).click();

	const edited = page.locator('article').filter({ hasText: 'Typo fixed' }).first();
	await expect(edited).toBeVisible({ timeout: 10_000 });
	await expect(edited.getByText('(edited)')).toBeVisible();
	await expect(page.getByText('Typpo here')).toHaveCount(0);

	// Delete goes through the shared confirm dialog.
	const dialog = page.getByRole('alertdialog');
	await clickUntil(edited.getByRole('button', { name: 'Delete comment' }), async () => {
		await expect(dialog).toBeVisible({ timeout: 2_000 });
	});
	await dialog.getByRole('button', { name: 'Delete comment', exact: true }).click();
	await expect(page.getByText('Typo fixed')).toHaveCount(0, { timeout: 10_000 });

	// The events outlive the comment.
	const events = await body<{ items: { type: string; payload: Record<string, unknown> }[] }>(
		await api.get(`/api/v1/events?issue=${issue.id}`)
	);
	const types = events.items.map((e) => e.type);
	expect(types).toContain('issue.comment_edited');
	expect(types).toContain('issue.comment_deleted');
	expect(events.items.find((e) => e.type === 'issue.comment_deleted')?.payload.comment_id).toBe(
		created.id
	);
});

test('workflow library shows the read-only standard workflow with its graph', async ({ page }) => {
	await gotoHydrated(page, '/workflows');
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
	await gotoHydrated(page, '/projects');
	await clickUntil(page.getByRole('button', { name: /New project/ }), async () => {
		await expect(page.getByLabel('Name')).toBeVisible({ timeout: 2_000 });
	});
	await page.getByLabel('Name').fill(projectName);
	await page.getByRole('button', { name: 'Create project' }).click();
	await expect(page.getByText(/already exists/)).toBeVisible();
});

// --- list memory -------------------------------------------------------------
//
// The issues list keeps its filters in the URL and nowhere else, so every route
// back to it used to drop them. The Issues tab and an issue's back link now
// return to the list as you left it.

/** The issue page's back link, as distinct from the header's Issues tab. */
const backLink = (page: Page) => page.locator('main').getByRole('link').first();

test('the Issues tab and an issue back link keep the list filters', async ({ page }) => {
	const query = `q=${encodeURIComponent(issueTitle)}`;
	await gotoHydrated(page, `/issues?${query}`);

	// The tab href picking up the query is also the proof that the page has
	// hydrated and recorded itself.
	const issuesTab = page.locator('header').getByRole('link', { name: 'Issues' });
	await expect(issuesTab).toHaveAttribute(
		'href',
		new RegExp(`q=UI(%20|\\+)smoke(%20|\\+)${runId}`)
	);

	await page.getByRole('link', { name: new RegExp(issueTitle) }).click();
	await expect(page).toHaveURL(new RegExp(`/issues/${projectName}/${issue.number}$`));

	// Back to the filtered list, not to a bare one.
	await expect(backLink(page)).toHaveText('Issues');
	await backLink(page).click();
	await expect(page).toHaveURL(new RegExp(`q=UI(%20|\\+)smoke(%20|\\+)${runId}`));

	// The nav tab restores them too, from wherever you are.
	await page.getByRole('link', { name: new RegExp(issueTitle) }).click();
	await expect(page).toHaveURL(new RegExp(`/issues/${projectName}/${issue.number}$`));
	await page.locator('header').getByRole('link', { name: 'Issues' }).click();
	await expect(page).toHaveURL(new RegExp(`q=UI(%20|\\+)smoke(%20|\\+)${runId}`));
	await expect(page.getByRole('link', { name: new RegExp(issueTitle) })).toBeVisible();
});

test('an issue reached from a project page goes back to that project', async ({ page }) => {
	await gotoHydrated(page, `/projects/${project.id}`);

	// The Done tab is a plain link, so it works before hydration too. Landing
	// on `?category=done` also proves the page has recorded itself — and the
	// list must still show the issue, so switch back to Open by the same route.
	await page.getByRole('link', { name: /^Done\b/ }).click();
	await expect(page).toHaveURL(/category=done/);
	await page.getByRole('link', { name: /^Open\b/ }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
	// Now a filter that keeps the issue listed: Ready only, from the menu.
	await clickUntil(page.getByRole('button', { name: /^Filter/ }), async () => {
		await expect(page.getByRole('checkbox', { name: 'Ready only' })).toBeVisible({
			timeout: 2_000
		});
	});
	await page.getByRole('checkbox', { name: 'Ready only' }).check();
	await expect(page).toHaveURL(/ready=1/);
	await page.keyboard.press('Escape');

	await page.getByRole('link', { name: new RegExp(issueTitle) }).click();
	await expect(page).toHaveURL(new RegExp(`/issues/${projectName}/${issue.number}$`));

	// The back link names the project, and returns to it still filtered.
	await expect(backLink(page)).toHaveText(projectName);
	await backLink(page).click();
	await expect(page).toHaveURL(`/projects/${project.id}?ready=1`);
});

/** The resolved value of one CSS property, as the browser paints it. */
const cssValue = (target: Locator, property: string) =>
	target.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);

test.describe('with a dark system preference', () => {
	test.use({ colorScheme: 'dark' });

	// The filter checkboxes used to be bare `<input type="checkbox">`, which the
	// browser paints in its own palette — a warm tan border against the app's
	// cool slate. Pinned by comparison with a control that is unarguably on
	// palette rather than against a hard-coded color, so a theme edit that moves
	// `--input` or `--primary` moves the expectation with it.
	test('filter checkboxes are painted from the app palette, not the browser default', async ({
		page
	}) => {
		await gotoHydrated(page, '/issues');
		await expect(page.locator('html')).toHaveClass(/\bdark\b/);

		// Named from `aria-label`: the visible text sits in the wrapping <label>,
		// which does not name a button. It lives in the Filter menu now.
		const readyOnly = page.getByRole('checkbox', { name: 'Ready only' });
		const searchField = page.getByRole('textbox', { name: 'Search issues' });
		await clickUntil(page.getByRole('button', { name: /^Filter/ }), async () => {
			await expect(readyOnly).toBeVisible({ timeout: 2_000 });
		});

		// Unchecked, it wears `--input` — the same border and fill as the search
		// field standing next to it.
		expect(await cssValue(readyOnly, 'border-color')).toBe(
			await cssValue(searchField, 'border-color')
		);
		expect(await cssValue(readyOnly, 'background-color')).toBe(
			await cssValue(searchField, 'background-color')
		);

		// Checked, it fills with `--primary` — the same fill as a default button.
		// bits-ui stamps `data-state`, so this is also what proves the
		// `data-checked` variant in app.css is wired to something real.
		await clickUntil(readyOnly, async () => {
			await expect(page).toHaveURL(/ready=1/, { timeout: 2_000 });
		});
		await expect(readyOnly).toBeChecked();
		// Polled, not read once: the control carries `transition-colors`, so a
		// single read lands mid-interpolation on a half-transparent oklab().
		const primary = await cssValue(
			page.getByRole('button', { name: 'New issue' }),
			'background-color'
		);
		await expect.poll(() => cssValue(readyOnly, 'background-color')).toBe(primary);
	});
});
