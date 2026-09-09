/**
 * The project focus (Tines/259): a per-user, server-side scope shown in the
 * app chrome and read by the issues list and New issue.
 */
import type { Project, UserPreferences } from '@tines/shared';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ALICE, CAROL, RUNROW } from './constants.mjs';
import {
	apiClient,
	body,
	clickToOpen,
	DESKTOP,
	gotoHydrated,
	PHONE,
	resetFocus,
	runId,
	signIn
} from './helpers';

const A_NAME = `focus-a-${runId}`;
const B_NAME = `focus-b-${runId}`;
let aId: string;
let bId: string;

/** The header control, which doubles as the assertion for the current focus. */
const switcher = (page: Page) => page.getByRole('button', { name: /^Project focus:/ });

/**
 * Opens the switcher and picks an entry, retrying the whole gesture until the
 * chrome agrees. Choosing re-renders the layout (`invalidateAll`), so a second
 * choice can find a menu item that detaches under the click — seen only on CI.
 * Retrying the open-and-click, keyed on the outcome, is the stable shape;
 * choosing twice is idempotent, so a retry costs nothing.
 *
 * `name` matches the menu entry, `expected` the full focus name the chrome
 * then reports in its `aria-label`, which is untruncated at every width.
 */
async function chooseFocus(page: Page, name: string, expected = name): Promise<void> {
	const item = page.getByRole('menuitemradio', { name });
	await expect(async () => {
		if (!(await item.isVisible())) await switcher(page).click();
		await item.click({ timeout: 2_000 });
		await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${expected}`, {
			timeout: 5_000
		});
	}).toPass({ timeout: 20_000 });
}

async function open(browser: Browser, viewport: typeof DESKTOP, path = '/issues'): Promise<Page> {
	const context = await browser.newContext({ viewport });
	await signIn(context, ALICE.sessionToken);
	const page = await context.newPage();
	// Hydrated, not merely loaded: every case here clicks, and a click landing
	// before SvelteKit attaches its listeners is dropped (only ever seen on CI).
	await gotoHydrated(page, path);
	return page;
}

test.describe.serial('project focus', () => {
	test.beforeEach(async ({ request }) => {
		await resetFocus(request);
	});

	test('seeds two projects with an issue each', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		aId = (await body<Project>(await api.post('/api/v1/projects', { name: A_NAME }))).id;
		bId = (await body<Project>(await api.post('/api/v1/projects', { name: B_NAME }))).id;
		for (const [id, name] of [
			[aId, A_NAME],
			[bId, B_NAME]
		]) {
			const res = await api.post(`/api/v1/projects/${id}/issues`, { title: `${name} issue` });
			expect(res.status(), await res.text()).toBe(201);
			const context = await api.post('/api/v1/context', {
				kind: 'prompt',
				name: `${name}-context`,
				body: `${name} only`,
				project_id: id
			});
			expect(context.status(), await context.text()).toBe(201);
		}
		for (const project_id of [aId, bId]) {
			const rule = await api.post('/api/v1/routing-rules', {
				project_id,
				targets: [{ runner_id: RUNROW.runnerId }]
			});
			expect(rule.status(), await rule.text()).toBe(201);
		}
	});

	test('the chrome shows the switcher and choosing a project sticks', async ({
		browser,
		request
	}) => {
		const page = await open(browser, DESKTOP);
		await expect(switcher(page)).toHaveAttribute('aria-label', 'Project focus: All projects');

		await chooseFocus(page, A_NAME);
		await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${A_NAME}`);
		// The scope is the chrome's, not the URL's.
		await expect(page).toHaveURL(/\/issues$/);

		const prefs = await body<UserPreferences>(
			await apiClient(request, ALICE.apiKey).get('/api/v1/preferences')
		);
		expect(prefs.focused_project_id).toBe(aId);

		// A fresh browser context, same user: the focus is server-side.
		const fresh = await open(browser, DESKTOP);
		await expect(switcher(fresh)).toHaveAttribute('aria-label', `Project focus: ${A_NAME}`);
		await fresh.close();
		await page.close();
	});

	test('the phone header carries the switcher, not the bottom bar', async ({ browser }) => {
		// Human review, round 2: the switcher is in the header at every width —
		// the phone header has the room, the bottom bar's sixth of a screen did
		// not, and the Projects slot is a plain link to the grid again.
		const page = await open(browser, PHONE);
		await expect(switcher(page)).toBeVisible();
		await expect(switcher(page)).toContainText('All projects');

		await chooseFocus(page, A_NAME);
		await expect(switcher(page)).toContainText(A_NAME);
		// One control, not two: the bottom bar navigates and says nothing about
		// the focus.
		const bottomBar = page.getByRole('navigation', { name: 'Primary' });
		await expect(bottomBar.getByRole('link', { name: 'Projects' })).toHaveAttribute(
			'href',
			`/projects/${aId}`
		);
		await expect(bottomBar.getByRole('button', { name: /^Project focus:/ })).toHaveCount(0);
		await page.close();
	});

	test('the focused list drops the project prefix and matches the API counts', async ({
		browser,
		request
	}) => {
		const page = await open(browser, DESKTOP, `/issues?project=${encodeURIComponent(A_NAME)}`);
		await expect(page).toHaveURL(/\/issues$/);
		await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${A_NAME}`);

		await expect(page.getByRole('link', { name: new RegExp(`${A_NAME} issue`) })).toBeVisible();
		await expect(page.getByText(`${A_NAME}/`, { exact: true })).toHaveCount(0);
		await expect(page.getByRole('link', { name: new RegExp(`${B_NAME} issue`) })).toHaveCount(0);

		// The category counts agree with the same scope over the API.
		const listed = await body<{ items: unknown[] }>(
			await apiClient(request, ALICE.apiKey).get(`/api/v1/issues?project=${aId}`)
		);
		const openTab = page.getByRole('link', { name: /^Open/ });
		await expect(openTab).toContainText(String(listed.items.length));
		await page.close();
	});

	for (const [label, viewport] of [
		['desktop', DESKTOP],
		['phone', PHONE]
	] as const) {
		test(`remaining focused surfaces and cross-project offer work on ${label}`, async ({
			browser
		}) => {
			const page = await open(browser, viewport, `/issues?project=${encodeURIComponent(A_NAME)}`);

			const contextRef = label === 'desktop' ? A_NAME : aId;
			await gotoHydrated(page, `/context?project=${encodeURIComponent(contextRef)}`);
			await expect(page).toHaveURL('/context');
			await expect(page.getByLabel('Filter by project')).toHaveCount(0);
			await expect(page.locator('p').filter({ hasText: /shared items?/ })).toContainText(
				/\(global and state-scoped\)\s+appl(?:y|ies) here too/
			);
			await expect(page.getByText(`${A_NAME}-context`, { exact: true })).toBeVisible();
			await expect(page.getByText(`${B_NAME}-context`, { exact: true })).toHaveCount(0);
			await gotoHydrated(page, `/context?project=nope-${runId}`);
			await expect(page.getByRole('status')).toContainText(`No project “nope-${runId}”`);
			await expect(page.getByText(`${A_NAME}-context`, { exact: true })).toBeVisible();

			await gotoHydrated(page, '/activity');
			await expect(page.getByLabel('Filter by project')).toHaveCount(0);
			const issueLinks = page.locator(`a[href^="/issues/"]`);
			await expect(issueLinks.first()).toBeVisible();
			expect(
				await issueLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href')))
			).toEqual(expect.arrayContaining([`/issues/${encodeURIComponent(A_NAME)}/1`]));
			expect(
				await issueLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href')))
			).not.toContain(`/issues/${encodeURIComponent(B_NAME)}/1`);

			await gotoHydrated(page, '/workflows');
			const standard = page.locator('a[href="/workflows/wf_standard"]');
			await expect(standard).toBeVisible();
			await expect(standard).toContainText('1 open issue');
			await expect(standard).toContainText('Project default');
			const otherWorkflows = page.locator('details');
			const otherSummary = page.getByText(/Other workflows in your library \(\d+\)/);
			await expect(otherSummary).toBeVisible();
			await expect(otherWorkflows).not.toHaveAttribute('open', '');
			await otherSummary.focus();
			await page.keyboard.press('Enter');
			await expect(otherWorkflows).toHaveAttribute('open', '');
			await standard.click();
			await expect(page.getByRole('heading', { level: 1, name: /Standard/ })).toContainText(
				'Project default'
			);
			await expect(page.getByText(`1 open issue in ${A_NAME} uses this workflow`)).toBeVisible();

			await gotoHydrated(page, '/agents');
			const routingRules = page.getByRole('list', { name: 'Routing rules' });
			await expect(routingRules.getByText(A_NAME, { exact: true })).toBeVisible();
			await expect(routingRules.getByText(B_NAME, { exact: true })).toHaveCount(0);
			await page.getByLabel('Show ended runs').check();
			await expect(
				page.getByRole('link', { name: new RegExp(`${RUNROW.projectName}/#`) })
			).toHaveCount(0);
			// A negative-only assertion could pass with an accidentally empty
			// focused list. Focus the seeded run's own project and prove the same
			// row appears, then return to A for the cross-project issue journey.
			await gotoHydrated(page, `/issues?project=${RUNROW.projectId}`);
			await gotoHydrated(page, '/agents');
			await page.getByLabel('Show ended runs').check();
			await expect(
				page.getByRole('link', { name: `${RUNROW.projectName}/#${RUNROW.issueNumber}` })
			).toHaveCount(2);
			const ruleDialog = page.getByRole('dialog', { name: 'New routing rule' });
			await gotoHydrated(page, `/issues?project=${aId}`);
			await gotoHydrated(page, '/agents');
			await clickToOpen(page.getByRole('button', { name: 'Add rule' }), ruleDialog);
			await expect(ruleDialog.getByLabel('Project', { exact: true })).toHaveValue(aId);
			await page.keyboard.press('Escape');

			await gotoHydrated(page, `/issues/${encodeURIComponent(B_NAME)}/1`);
			await expect(page.getByRole('button', { name: `Focus ${B_NAME}` })).toBeVisible();
			await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${A_NAME}`);
			const back = page.locator('main').getByRole('link', { name: 'Issues', exact: true });
			await expect(back).toHaveAttribute('href', '/issues');
			await back.click();
			await expect(page.getByRole('link', { name: new RegExp(`${A_NAME} issue`) })).toBeVisible();
			await expect(page.getByRole('link', { name: new RegExp(`${B_NAME} issue`) })).toHaveCount(0);

			await gotoHydrated(page, `/issues/${encodeURIComponent(B_NAME)}/1`);
			await page.getByRole('button', { name: `Focus ${B_NAME}` }).click();
			await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${B_NAME}`);
			await page.locator('main').getByRole('link', { name: 'Issues', exact: true }).click();
			await expect(page.getByRole('link', { name: new RegExp(`${B_NAME} issue`) })).toBeVisible();
			await expect(page.getByRole('link', { name: new RegExp(`${A_NAME} issue`) })).toHaveCount(0);

			await expect(page.getByRole('link', { name: 'Projects' }).first()).toHaveAttribute(
				'href',
				`/projects/${bId}`
			);
			await page.close();
		});
	}

	test('routing editor one-shots are consumed on success and every invalid shape', async ({
		browser,
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		const archived = await body<Project>(
			await api.post('/api/v1/projects', { name: `focus-archived-${runId}` })
		);
		expect((await api.post(`/api/v1/projects/${archived.id}/archive`)).ok()).toBe(true);

		const page = await open(browser, DESKTOP, `/agents?keep=1&new=rule&project=${aId}#routing`);
		await expect(page.getByRole('dialog', { name: 'New routing rule' })).toBeVisible();
		await expect(page.getByRole('dialog').getByLabel('Project', { exact: true })).toHaveValue(aId);
		await expect(page).toHaveURL('/agents?keep=1#routing');
		await page.keyboard.press('Escape');

		for (const query of [
			'new=rule',
			`new=rule&project=nope-${runId}`,
			`new=rule&project=${archived.id}`
		]) {
			await gotoHydrated(page, `/agents?keep=1&${query}#routing`);
			await expect(page.getByText('That project is unavailable for routing.')).toBeVisible();
			await expect(page).toHaveURL('/agents?keep=1#routing');
			await expect(page.getByRole('dialog', { name: 'New routing rule' })).toHaveCount(0);
		}
		await page.close();
	});

	test('New issue opens on the focus, and empty and required under All projects', async ({
		browser,
		request
	}) => {
		const focused = await open(browser, DESKTOP, `/issues?project=${encodeURIComponent(A_NAME)}`);
		// Scoped to the dialog: the chrome's switcher is labelled `Project focus: …`,
		// which an unscoped `getByLabel('Project')` also matches.
		const form = focused.getByRole('dialog');
		await clickToOpen(focused.getByRole('button', { name: 'New issue' }), form);
		await expect(form.getByLabel('Project', { exact: true })).toHaveValue(aId);
		// The project's default workflow comes with it.
		await expect(form.getByLabel('Workflow', { exact: true })).not.toHaveValue('');
		await focused.close();

		// The half above focused a project, which also records it as
		// `last_project_id`; clear both to reach the true All-projects state.
		await resetFocus(request);
		const all = await open(browser, DESKTOP);
		await clickToOpen(all.getByRole('button', { name: 'New issue' }), all.getByRole('dialog'));
		// Nothing to fall back to: the select starts empty and the form cannot
		// be submitted.
		await expect(all.getByRole('dialog').getByLabel('Project', { exact: true })).toHaveValue('');
		await expect(all.getByRole('button', { name: 'Create issue' })).toBeDisabled();
		await all.close();
	});

	test('an unknown ?project= changes nothing and says so', async ({ browser }) => {
		const page = await open(browser, DESKTOP, `/issues?project=${encodeURIComponent(A_NAME)}`);
		await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${A_NAME}`);

		await page.goto(`/issues?project=nope-${runId}`);
		await expect(page.getByRole('status')).toContainText(`No project “nope-${runId}”`);
		// Unchanged focus, list still populated.
		await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${A_NAME}`);
		await expect(page.getByRole('link', { name: new RegExp(`${A_NAME} issue`) })).toBeVisible();
		await page.close();
	});

	test('opening a project page focuses it', async ({ browser }) => {
		const page = await open(browser, DESKTOP, `/projects/${bId}`);
		await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${B_NAME}`);
		await page.close();
	});

	test('the switcher still moves the focus off a project page', async ({ browser, request }) => {
		// Regression (Tines/259 review): the project page announces its focus in
		// an effect, and a guard that read the optimistic hint made that hint a
		// dependency — so choosing anything in the switcher re-ran the effect and
		// PATCHed this project straight back, server-side and permanently.
		const page = await open(browser, DESKTOP, `/projects/${aId}`);
		await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${A_NAME}`);
		const focusedId = async () =>
			(
				await body<UserPreferences>(
					await apiClient(request, ALICE.apiKey).get('/api/v1/preferences')
				)
			).focused_project_id;

		await chooseFocus(page, B_NAME);
		await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${B_NAME}`);
		expect(await focusedId()).toBe(bId);

		await chooseFocus(page, 'All projects');
		await expect(switcher(page)).toHaveAttribute('aria-label', 'Project focus: All projects');
		expect(await focusedId()).toBe(null);
		await page.close();
	});

	test('creating a project focuses it', async ({ browser }) => {
		const name = `focus-c-${runId}`;
		const page = await open(browser, DESKTOP, '/projects');
		const dialog = page.getByRole('dialog');
		await clickToOpen(page.getByRole('button', { name: 'New project' }), dialog);
		await dialog.getByLabel('Name').fill(name);
		await page.getByRole('button', { name: 'Create project' }).click();
		await expect(page).toHaveURL(/\/projects\/prj_/);
		await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${name}`);
		await page.close();
	});

	for (const [label, viewport] of [
		['desktop', DESKTOP],
		['phone', PHONE]
	] as const) {
		test(`archiving the focused project falls back to All projects, for good on ${label}`, async ({
			browser,
			request
		}) => {
			const api = apiClient(request, ALICE.apiKey);
			const page = await open(browser, viewport, `/issues?project=${encodeURIComponent(B_NAME)}`);
			await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${B_NAME}`);

			expect((await api.post(`/api/v1/projects/${bId}/archive`)).ok()).toBe(true);
			await page.reload();
			await expect(switcher(page)).toHaveAttribute('aria-label', 'Project focus: All projects');
			await clickToOpen(switcher(page), page.getByRole('menuitemradio', { name: 'All projects' }));
			await expect(page.getByRole('menuitemradio', { name: B_NAME })).toHaveCount(0);
			await page.keyboard.press('Escape');

			// The pointer was cleared, so thawing the project does not bring it back.
			expect((await api.post(`/api/v1/projects/${bId}/unarchive`)).ok()).toBe(true);
			await page.reload();
			await expect(switcher(page)).toHaveAttribute('aria-label', 'Project focus: All projects');
			await page.close();
		});
	}

	test('a run key cannot read or move its owner’s focus', async ({ request }) => {
		const api = apiClient(request, RUNROW.runKey);
		for (const res of [
			await api.get('/api/v1/preferences'),
			await api.patch('/api/v1/preferences', { focused_project_id: aId })
		]) {
			expect(res.status()).toBe(403);
		}
	});

	test('a run key’s issue list is unscoped whatever its owner is focused on', async ({
		request
	}) => {
		// The focus is a UI scope, never a data one: set one over the API, then
		// read the list back with a run key and see both projects’ issues.
		const alice = apiClient(request, ALICE.apiKey);
		expect((await alice.patch('/api/v1/preferences', { focused_project_id: aId })).ok()).toBe(true);

		const res = await apiClient(request, RUNROW.runKey).get('/api/v1/issues?limit=100');
		expect(res.status(), await res.text()).toBe(200);
		const titles = (await body<{ items: { title: string }[] }>(res)).items.map((i) => i.title);
		expect(titles).toContain(`${A_NAME} issue`);
		expect(titles).toContain(`${B_NAME} issue`);
	});
});

test.describe.serial('the switcher below two projects', () => {
	// Carol exists precisely for this: no projects of her own, and no other
	// spec creates any for her.
	async function carol(browser: Browser): Promise<Page> {
		const context = await browser.newContext({ viewport: DESKTOP });
		await signIn(context, CAROL.sessionToken);
		const page = await context.newPage();
		await gotoHydrated(page, '/issues');
		return page;
	}

	test('is hidden at zero and at one project, and appears at two', async ({ browser, request }) => {
		const api = apiClient(request, CAROL.apiKey);
		const page = await carol(browser);
		await expect(switcher(page)).toHaveCount(0);

		const first = await body<Project>(
			await api.post('/api/v1/projects', { name: `carol-1-${runId}` })
		);
		await page.reload();
		await expect(switcher(page)).toHaveCount(0);
		// One project still behaves as the focus for New issue.
		await clickToOpen(page.getByRole('button', { name: 'New issue' }), page.getByRole('dialog'));
		await expect(page.getByRole('dialog').getByLabel('Project', { exact: true })).toHaveValue(
			first.id
		);
		await page.keyboard.press('Escape');

		await api.post('/api/v1/projects', { name: `carol-2-${runId}` });
		await page.reload();
		await expect(switcher(page)).toBeVisible();
		await page.close();
	});
});
