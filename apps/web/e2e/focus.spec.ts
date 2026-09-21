/**
 * The project focus (Tines/259): a per-user, server-side scope shown in the
 * app chrome and read by the issues list and New issue.
 */
import type { Project, UserPreferences } from '@tines/shared';
import type { Browser, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE, CAROL, RUNROW } from './constants.mjs';
import {
	apiClient,
	body,
	clickToOpen,
	clickUntil,
	DESKTOP,
	gotoHydrated,
	PHONE,
	resetFocus,
	runCleanupSteps,
	signIn
} from './helpers';

type FocusWorld = {
	aName: string;
	bName: string;
	aId: string;
	bId: string;
	workflowId: string;
};

const focusTest = test.extend<{}, { world: FocusWorld }>({
	world: [
		async ({ apiFor, uniqueName, workerRequest }, use) => {
			const api = apiFor(ALICE);
			const aName = uniqueName('focus-a', { maxLength: 40 });
			const bName = uniqueName('focus-b', { maxLength: 40 });
			let workflowId: string | undefined;
			const projectIds: string[] = [];
			const contextIds: string[] = [];
			const ruleIds: string[] = [];
			try {
				workflowId = (
					await body<{ id: string }>(
						await api.post('/api/v1/workflows', {
							name: uniqueName('focus-workflow'),
							description: 'focus fixture',
							initial_state: 'Open',
							states: [{ name: 'Open', category: 'active' }],
							transitions: []
						})
					)
				).id;
				const aId = (await body<Project>(await api.post('/api/v1/projects', { name: aName }))).id;
				projectIds.push(aId);
				const bId = (await body<Project>(await api.post('/api/v1/projects', { name: bName }))).id;
				projectIds.push(bId);
				for (const [id, name] of [
					[aId, aName],
					[bId, bName]
				]) {
					await body(await api.post(`/api/v1/projects/${id}/issues`, { title: `${name} issue` }));
					contextIds.push(
						(
							await body<{ id: string }>(
								await api.post('/api/v1/context', {
									kind: 'prompt',
									name: `${name}-context`,
									body: `${name} only`,
									project_id: id
								})
							)
						).id
					);
				}
				for (const project_id of [aId, bId]) {
					ruleIds.push(
						(
							await body<{ id: string }>(
								await api.post('/api/v1/routing-rules', {
									project_id,
									targets: [{ runner_id: RUNROW.runnerId }]
								})
							)
						).id
					);
				}
				await use({ aName, bName, aId, bId, workflowId });
			} finally {
				await runCleanupSteps([
					{ name: 'reset Alice focus', run: () => resetFocus(workerRequest) },
					...ruleIds.map((id) => ({
						name: `delete focus routing rule ${id}`,
						run: async () => {
							expect((await api.delete(`/api/v1/routing-rules/${id}`)).status()).toBe(204);
						}
					})),
					...contextIds.map((id) => ({
						name: `delete focus context ${id}`,
						run: async () => {
							expect((await api.delete(`/api/v1/context/${id}`)).status()).toBe(204);
						}
					})),
					...projectIds.map((id) => ({
						name: `archive focus project ${id}`,
						run: async () => {
							expect((await api.post(`/api/v1/projects/${id}/archive`)).status()).toBe(200);
						}
					})),
					...(workflowId
						? [
								{
									name: `delete focus workflow ${workflowId}`,
									run: async () => {
										expect((await api.delete(`/api/v1/workflows/${workflowId}`)).status()).toBe(
											204
										);
									}
								}
							]
						: [])
				]);
			}
		},
		{ scope: 'worker' }
	]
});

/** The header control, which doubles as the assertion for the current focus. */
const switcher = (page: Page) => page.getByRole('button', { name: /^Project focus:/ });

async function pressProjectMenuKey(
	page: Page,
	key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
	from: Locator,
	to: Locator
): Promise<void> {
	await expect(from).toBeFocused();
	await page.keyboard.press(key);
	await expect(to).toBeFocused();
}

/**
 * Opens the switcher and picks an entry, retrying the whole gesture until the
 * chrome agrees. Choosing re-runs focus-aware loads (`app:preferences`), so a second
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

function holdNextPreferencePatch(page: Page, outcome: 'forward' | 'fail' = 'forward') {
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const patchStarted = new Promise<void>((resolve) => (started = resolve));
	const events: string[] = [];
	page.on('request', (request) => {
		if (new URL(request.url()).pathname === '/issues/__data.json') events.push('issues-request');
	});
	void page.route('**/api/v1/preferences', async (route) => {
		if (route.request().method() !== 'PATCH') return route.continue();
		events.push('patch-request');
		started();
		await gate;
		if (outcome === 'fail') {
			events.push('patch-response');
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ error: { code: 'held_failure', message: 'Held failure' } })
			});
		} else {
			const response = await route.fetch();
			events.push('patch-response');
			await route.fulfill({ response });
		}
	});
	return { events, patchStarted, release };
}

function holdPreferencePatches(page: Page, count: number) {
	const releases: (() => void)[] = [];
	const starts: Promise<void>[] = [];
	const started: (() => void)[] = [];
	const events: string[] = [];
	for (let index = 0; index < count; index += 1) {
		starts.push(new Promise<void>((resolve) => (started[index] = resolve)));
	}
	void page.route('**/api/v1/preferences', async (route) => {
		if (route.request().method() !== 'PATCH') return route.continue();
		const index = releases.length;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		releases.push(release);
		events.push(`patch-${index + 1}-request`);
		started[index]?.();
		await gate;
		const response = await route.fetch();
		events.push(`patch-${index + 1}-response`);
		await route.fulfill({ response });
	});
	page.on('request', (request) => {
		if (new URL(request.url()).pathname === '/issues/__data.json') events.push('issues-request');
	});
	return {
		events,
		started: (index: number) => starts[index],
		release: (index: number) => releases[index]?.(),
		releaseAll: () => releases.forEach((release) => release())
	};
}

focusTest.describe.serial('project focus', () => {
	focusTest.beforeEach(async ({ request, world }) => {
		await resetFocus(request);
	});

	focusTest(
		'the chrome shows the switcher and choosing a project sticks',
		async ({ browser, request, world }) => {
			const page = await open(browser, DESKTOP);
			await expect(switcher(page)).toHaveAttribute('aria-label', 'Project focus: All projects');

			await chooseFocus(page, world.aName);
			await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.aName}`);
			// The scope is the chrome's, not the URL's.
			await expect(page).toHaveURL(/\/issues$/);

			const prefs = await body<UserPreferences>(
				await apiClient(request, ALICE.apiKey).get('/api/v1/preferences')
			);
			expect(prefs.focused_project_id).toBe(world.aId);

			// A fresh browser context, same user: the focus is server-side.
			const fresh = await open(browser, DESKTOP);
			await expect(switcher(fresh)).toHaveAttribute('aria-label', `Project focus: ${world.aName}`);
			await fresh.close();
			await page.close();
		}
	);

	focusTest(
		'a failed focus choice reopens the menu and can be retried',
		async ({ browser, world }) => {
			const page = await open(browser, DESKTOP);
			await page.route('**/api/v1/preferences', async (route) => {
				if (route.request().method() !== 'PATCH') return route.continue();
				await route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ error: { code: 'focus_failure', message: 'Focus choice failed' } })
				});
			});

			await switcher(page).click();
			await page.getByRole('menuitemradio', { name: world.aName }).click();
			await expect(page.getByRole('alert')).toHaveText('Focus choice failed');
			await expect(switcher(page)).toHaveAttribute('aria-expanded', 'true');
			await expect(switcher(page)).toHaveAttribute('aria-label', 'Project focus: All projects');
			await expect(page.getByRole('menuitemradio', { name: 'All projects' })).toBeFocused();

			await page.unroute('**/api/v1/preferences');
			await page.getByRole('menuitemradio', { name: world.aName }).click();
			await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.aName}`);
			await page.close();
		}
	);

	for (const [label, viewport] of [
		['desktop', DESKTOP],
		['phone', PHONE]
	] as const) {
		focusTest(
			`pointer and keyboard opening focus the checked choice on ${label}`,
			async ({ browser }) => {
				const page = await open(browser, viewport);
				const checked = page.getByRole('menuitemradio', { name: 'All projects' });

				await switcher(page).click();
				await expect(checked).toBeFocused();
				await page.keyboard.press('Escape');
				await expect(switcher(page)).toBeFocused();

				await page.keyboard.press('Enter');
				await expect(checked).toBeFocused();
				await page.keyboard.press('Escape');
				await expect(switcher(page)).toBeFocused();
				await page.close();
			}
		);
	}

	focusTest(
		'the phone header carries project controls outside the primary navigation',
		async ({ browser, world }) => {
			const page = await open(browser, PHONE);
			await expect(switcher(page)).toBeVisible();
			await expect(switcher(page)).toContainText('All projects');

			await chooseFocus(page, world.aName);
			await expect(switcher(page)).toContainText(world.aName);
			const bottomBar = page.getByRole('navigation', { name: 'Primary' });
			await expect(bottomBar.getByRole('link')).toHaveText(['Issues', 'Workflows', 'Agents']);
			await expect(bottomBar.getByRole('button', { name: /^Project focus:/ })).toHaveCount(0);
			await switcher(page).click();
			await expect(page.getByRole('menuitem', { name: 'Open project' })).toHaveAttribute(
				'href',
				`/projects/${world.aId}`
			);
			await page.close();
		}
	);

	for (const [label, viewport] of [
		['desktop', DESKTOP],
		['phone', PHONE]
	] as const) {
		focusTest(
			`all five contextual links navigate without changing project focus on ${label}`,
			async ({ browser, world }) => {
				const page = await open(browser, viewport);
				await chooseFocus(page, world.bName);
				const issuePath = `/issues/${encodeURIComponent(world.aName)}/1`;

				await gotoHydrated(page, issuePath);
				const contextFold = page.getByRole('button', { name: /^Context/ }).locator('xpath=..');
				const issueContextLink =
					label === 'phone'
						? contextFold.getByRole('link', { name: 'View all context' })
						: page.getByRole('link', { name: 'View all context' });
				if (label === 'phone') {
					await expect(issueContextLink).toBeHidden();
					await contextFold.getByRole('button', { name: /^Context/ }).click();
				}
				await expect(issueContextLink).toBeVisible();
				await issueContextLink.click();
				await expect(page).toHaveURL('/context');
				await expect(page.getByRole('heading', { name: 'Context', level: 1 })).toBeVisible();
				await expect(page.getByText(`${world.bName}-context`, { exact: true })).toBeVisible();
				await expect(page.getByText(`${world.aName}-context`, { exact: true })).toHaveCount(0);
				await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.bName}`);

				await gotoHydrated(page, issuePath);
				const activityFold = page.getByRole('button', { name: /^Activity/ }).locator('xpath=..');
				const issueActivityLink =
					label === 'phone'
						? activityFold.getByRole('link', { name: 'View all activity' })
						: page.getByRole('link', { name: 'View all activity' });
				if (label === 'phone') {
					await expect(issueActivityLink).toBeHidden();
					await activityFold.getByRole('button', { name: /^Activity/ }).click();
				}
				await expect(issueActivityLink).toBeVisible();
				await issueActivityLink.click();
				await expect(page).toHaveURL('/activity');
				await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
				await expect(
					page.locator(`a[href="/issues/${encodeURIComponent(world.bName)}/1"]`).first()
				).toBeVisible();
				await expect(
					page.locator(`a[href="/issues/${encodeURIComponent(world.aName)}/1"]`)
				).toHaveCount(0);

				// This fixture has no state context: the link remains available on an empty surface.
				await gotoHydrated(page, `/workflows/${world.workflowId}`);
				await page.getByRole('link', { name: 'View all context' }).click();
				await expect(page).toHaveURL('/context');
				await expect(page.getByRole('heading', { name: 'Context', level: 1 })).toBeVisible();

				// A project page establishes its own focus. Move back to B while staying on A,
				// then prove both project links preserve B and its existing destination semantics.
				await gotoHydrated(page, `/projects/${world.aId}`);
				await chooseFocus(page, world.bName);
				await page.getByRole('link', { name: 'View all activity' }).click();
				await expect(page).toHaveURL('/activity');
				await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.bName}`);

				await gotoHydrated(page, `/projects/${world.aId}`);
				await chooseFocus(page, world.bName);
				await page.getByRole('link', { name: 'View all context' }).click();
				await expect(page).toHaveURL('/context');
				await expect(page.getByText(`${world.bName}-context`, { exact: true })).toBeVisible();
				await expect(page.getByText(`${world.aName}-context`, { exact: true })).toHaveCount(0);
				await page.close();
			}
		);
	}

	focusTest(
		'the focused list drops the project prefix and matches the API counts',
		async ({ browser, request, world }) => {
			const page = await open(
				browser,
				DESKTOP,
				`/issues?project=${encodeURIComponent(world.aName)}`
			);
			await expect(page).toHaveURL(/\/issues$/);
			await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.aName}`);

			await expect(
				page.getByRole('link', { name: new RegExp(`${world.aName} issue`) })
			).toBeVisible();
			await expect(page.getByText(`${world.aName}/`, { exact: true })).toHaveCount(0);
			await expect(
				page.getByRole('link', { name: new RegExp(`${world.bName} issue`) })
			).toHaveCount(0);

			// The category counts agree with the same scope over the API.
			const listed = await body<{ items: unknown[] }>(
				await apiClient(request, ALICE.apiKey).get(`/api/v1/issues?project=${world.aId}`)
			);
			const openTab = page.getByRole('link', { name: /^Open/ });
			await expect(openTab).toContainText(String(listed.items.length));
			await page.close();
		}
	);

	for (const [label, viewport] of [
		['desktop', DESKTOP],
		['phone', PHONE]
	] as const) {
		focusTest(
			`remaining focused surfaces and cross-project offer work on ${label}`,
			async ({ browser, world }) => {
				const page = await open(
					browser,
					viewport,
					`/issues?project=${encodeURIComponent(world.aName)}`
				);

				const contextRef = label === 'desktop' ? world.aName : world.aId;
				await gotoHydrated(page, `/context?project=${encodeURIComponent(contextRef)}`);
				await expect(page).toHaveURL('/context');
				await expect(page.getByLabel('Filter by project')).toHaveCount(0);
				await expect(page.locator('p').filter({ hasText: /shared items?/ })).toContainText(
					/\(global and state-scoped\)\s+appl(?:y|ies) here too/
				);
				await expect(page.getByText(`${world.aName}-context`, { exact: true })).toBeVisible();
				await expect(page.getByText(`${world.bName}-context`, { exact: true })).toHaveCount(0);
				await gotoHydrated(page, `/context?project=nope-${world.aId}`);
				await expect(page.getByRole('status')).toContainText(`No project “nope-${world.aId}”`);
				await expect(page.getByText(`${world.aName}-context`, { exact: true })).toBeVisible();

				await gotoHydrated(page, '/activity');
				await expect(page.getByLabel('Filter by project')).toHaveCount(0);
				const issueLinks = page.locator(`a[href^="/issues/"]`);
				await expect(issueLinks.first()).toBeVisible();
				expect(
					await issueLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href')))
				).toEqual(expect.arrayContaining([`/issues/${encodeURIComponent(world.aName)}/1`]));
				expect(
					await issueLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href')))
				).not.toContain(`/issues/${encodeURIComponent(world.bName)}/1`);

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
				await expect(
					page.getByText(`1 open issue in ${world.aName} uses this workflow`)
				).toBeVisible();

				await gotoHydrated(page, '/agents');
				const routingRules = page.getByRole('list', { name: 'Routing rules' });
				await expect(routingRules.getByText(world.aName, { exact: true })).toBeVisible();
				await expect(routingRules.getByText(world.bName, { exact: true })).toHaveCount(0);
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
				await gotoHydrated(page, `/issues?project=${world.aId}`);
				await gotoHydrated(page, '/agents');
				await clickToOpen(page.getByRole('button', { name: 'Add rule' }), ruleDialog);
				await expect(ruleDialog.getByLabel('Project', { exact: true })).toHaveValue(world.aId);
				await page.keyboard.press('Escape');

				await gotoHydrated(page, `/issues/${encodeURIComponent(world.bName)}/1`);
				await expect(page.getByRole('button', { name: `Focus ${world.bName}` })).toBeVisible();
				await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.aName}`);
				const back = page.locator('main').getByRole('link', { name: 'Issues', exact: true });
				await expect(back).toHaveAttribute('href', '/issues');
				await back.click();
				await expect(
					page.getByRole('link', { name: new RegExp(`${world.aName} issue`) })
				).toBeVisible();
				await expect(
					page.getByRole('link', { name: new RegExp(`${world.bName} issue`) })
				).toHaveCount(0);

				await gotoHydrated(page, `/issues/${encodeURIComponent(world.bName)}/1`);
				await page.getByRole('button', { name: `Focus ${world.bName}` }).click();
				await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.bName}`);
				await page.locator('main').getByRole('link', { name: 'Issues', exact: true }).click();
				await expect(
					page.getByRole('link', { name: new RegExp(`${world.bName} issue`) })
				).toBeVisible();
				await expect(
					page.getByRole('link', { name: new RegExp(`${world.aName} issue`) })
				).toHaveCount(0);

				await switcher(page).click();
				await expect(page.getByRole('menuitem', { name: 'Open project' })).toHaveAttribute(
					'href',
					`/projects/${world.bId}`
				);
				await page.close();
			}
		);
	}

	focusTest(
		'routing editor one-shots are consumed on success and every invalid shape',
		async ({ browser, request, uniqueName, world }) => {
			const api = apiClient(request, ALICE.apiKey);
			const archived = await body<Project>(
				await api.post('/api/v1/projects', { name: uniqueName('focus-archived') })
			);
			expect((await api.post(`/api/v1/projects/${archived.id}/archive`)).ok()).toBe(true);

			const page = await open(
				browser,
				DESKTOP,
				`/agents?keep=1&new=rule&project=${world.aId}#routing`
			);
			await expect(page.getByRole('dialog', { name: 'New routing rule' })).toBeVisible();
			await expect(page.getByRole('dialog').getByLabel('Project', { exact: true })).toHaveValue(
				world.aId
			);
			await expect(page).toHaveURL('/agents?keep=1#routing');
			await page.keyboard.press('Escape');

			for (const query of [
				'new=rule',
				`new=rule&project=nope-${world.aId}`,
				`new=rule&project=${archived.id}`
			]) {
				await gotoHydrated(page, `/agents?keep=1&${query}#routing`);
				await expect(page.getByText('That project is unavailable for routing.')).toBeVisible();
				await expect(page).toHaveURL('/agents?keep=1#routing');
				await expect(page.getByRole('dialog', { name: 'New routing rule' })).toHaveCount(0);
			}
			await page.close();
		}
	);

	focusTest(
		'New issue opens on the focus, and empty and required under All projects',
		async ({ browser, request, world }) => {
			const focused = await open(
				browser,
				DESKTOP,
				`/issues?project=${encodeURIComponent(world.aName)}`
			);
			// Scoped to the dialog: the chrome's switcher is labelled `Project focus: …`,
			// which an unscoped `getByLabel('Project')` also matches.
			const form = focused.getByRole('dialog');
			await clickToOpen(focused.getByRole('button', { name: 'New issue' }), form);
			await expect(form.getByLabel('Project', { exact: true })).toHaveValue(world.aId);
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
		}
	);

	focusTest('an unknown ?project= changes nothing and says so', async ({ browser, world }) => {
		const page = await open(browser, DESKTOP, `/issues?project=${encodeURIComponent(world.aName)}`);
		await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.aName}`);

		await page.goto(`/issues?project=nope-${world.aId}`);
		await expect(page.getByRole('status')).toContainText(`No project “nope-${world.aId}”`);
		// Unchanged focus, list still populated.
		await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.aName}`);
		await expect(
			page.getByRole('link', { name: new RegExp(`${world.aName} issue`) })
		).toBeVisible();
		await page.close();
	});

	focusTest('opening a project page focuses it', async ({ browser, world }) => {
		const page = await open(browser, DESKTOP, `/projects/${world.bId}`);
		await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.bName}`);
		await page.close();
	});

	for (const [label, viewport, hasTouch] of [
		['desktop', DESKTOP, false],
		['phone', PHONE, true]
	] as const) {
		focusTest(
			`immediate Issues navigation waits for project focus on ${label}`,
			async ({ browser, request, world }) => {
				const context = await browser.newContext({ viewport, hasTouch });
				await signIn(context, ALICE.sessionToken);
				const page = await context.newPage();
				await gotoHydrated(page, '/projects');
				const held = holdNextPreferencePatch(page);
				try {
					await page.getByRole('link', { name: world.aName }).click();
					await held.patchStarted;
					await expect(switcher(page)).toHaveAttribute(
						'aria-label',
						`Project focus: ${world.aName}`
					);

					const nav = label === 'phone' ? page.getByRole('navigation', { name: 'Primary' }) : page;
					const issues = nav.getByRole('link', { name: 'Issues', exact: true });
					if (label === 'desktop') await issues.hover();
					await issues.click({ noWaitAfter: true });
					await page.waitForTimeout(150);
					expect(held.events).not.toContain('issues-request');

					held.release();
					await expect(page).toHaveURL('/issues');
					await expect(
						page.getByRole('link', { name: new RegExp(`${world.aName} issue`) })
					).toBeVisible();
					await expect(
						page.getByRole('link', { name: new RegExp(`${world.bName} issue`) })
					).toHaveCount(0);
					await expect(switcher(page)).toHaveAttribute(
						'aria-label',
						`Project focus: ${world.aName}`
					);
					expect(held.events.indexOf('patch-response')).toBeLessThan(
						held.events.indexOf('issues-request')
					);
					await expect
						.poll(async () => {
							const prefs = await body<UserPreferences>(
								await apiClient(request, ALICE.apiKey).get('/api/v1/preferences')
							);
							return prefs.focused_project_id;
						})
						.toBe(world.aId);
				} finally {
					held.release();
					await context.close();
				}
			}
		);
	}

	focusTest('keyboard navigation waits without preloading', async ({ browser, world }) => {
		const page = await open(browser, DESKTOP, '/projects');
		const held = holdNextPreferencePatch(page);
		try {
			await page.getByRole('link', { name: world.aName }).click();
			await held.patchStarted;
			const issues = page.getByRole('link', { name: 'Issues', exact: true });
			await issues.focus();
			await page.keyboard.press('Enter');
			await page.waitForTimeout(150);
			expect(held.events).not.toContain('issues-request');
			held.release();
			await expect(page).toHaveURL('/issues');
			await expect(
				page.getByRole('link', { name: new RegExp(`${world.aName} issue`) })
			).toBeVisible();
		} finally {
			held.release();
			await page.close();
		}
	});

	focusTest(
		'a destination preloaded before project entry is reloaded after focus persists',
		async ({ browser, world }) => {
			const page = await open(browser, DESKTOP, '/projects');
			const issues = page.getByRole('link', { name: 'Issues', exact: true });
			const preload = page.waitForResponse((response) =>
				new URL(response.url()).pathname.endsWith('/issues/__data.json')
			);
			await issues.hover();
			await preload;
			const held = holdNextPreferencePatch(page);
			try {
				await page.getByRole('link', { name: world.aName }).click();
				await held.patchStarted;
				await page.getByRole('link', { name: 'Issues', exact: true }).click({ noWaitAfter: true });
				await page.waitForTimeout(150);
				expect(held.events).not.toContain('issues-request');
				held.release();
				await expect(page).toHaveURL('/issues');
				await expect(
					page.getByRole('link', { name: new RegExp(`${world.aName} issue`) })
				).toBeVisible();
				await expect(
					page.getByRole('link', { name: new RegExp(`${world.bName} issue`) })
				).toHaveCount(0);
			} finally {
				held.release();
				await page.close();
			}
		}
	);

	focusTest(
		'a failed automatic focus releases navigation under persisted focus',
		async ({ browser, request, world }) => {
			const pageErrors: Error[] = [];
			const page = await open(browser, DESKTOP, '/projects');
			page.on('pageerror', (error) => pageErrors.push(error));
			const held = holdNextPreferencePatch(page, 'fail');
			try {
				await page.getByRole('link', { name: world.aName }).click();
				await held.patchStarted;
				await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.aName}`);
				await page.getByRole('link', { name: 'Issues', exact: true }).click({ noWaitAfter: true });
				held.release();
				await expect(page).toHaveURL('/issues');
				await expect(switcher(page)).toHaveAttribute('aria-label', 'Project focus: All projects');
				await expect(
					page.getByRole('link', { name: new RegExp(`${world.aName} issue`) })
				).toBeVisible();
				await expect(
					page.getByRole('link', { name: new RegExp(`${world.bName} issue`) })
				).toBeVisible();
				const prefs = await body<UserPreferences>(
					await apiClient(request, ALICE.apiKey).get('/api/v1/preferences')
				);
				expect(prefs.focused_project_id).toBe(null);
				expect(pageErrors).toEqual([]);
			} finally {
				held.release();
				await page.close();
			}
		}
	);

	for (const [choiceLabel, choiceKind] of [
		['project B', 'project'],
		['All projects', 'all']
	] as const) {
		focusTest(
			`an explicit ${choiceLabel} choice stays ordered through immediate navigation`,
			async ({ browser, request, world }) => {
				const choice = choiceKind === 'project' ? world.bName : 'All projects';
				const expectedId = choiceKind === 'project' ? world.bId : null;
				const visible = choiceKind === 'project' ? world.bName : world.aName;
				const absent = choiceKind === 'project' ? world.aName : null;
				const page = await open(browser, DESKTOP, '/projects');
				const held = holdPreferencePatches(page, 2);
				try {
					await page.getByRole('link', { name: world.aName }).click();
					await held.started(0);
					await switcher(page).click();
					await page.getByRole('menuitemradio', { name: choice }).click({ noWaitAfter: true });
					await page.waitForTimeout(150);
					expect(held.events).toEqual(['patch-1-request']);

					held.release(0);
					await held.started(1);
					// The switcher handler is still awaiting its held write. Dispatch the
					// navigation synchronously so Playwright does not wait for that handler.
					await page
						.getByRole('link', { name: 'Issues', exact: true })
						.evaluate((link: HTMLAnchorElement) => link.click());
					await page.waitForTimeout(150);
					expect(held.events).not.toContain('issues-request');
					held.release(1);

					await expect(page).toHaveURL('/issues');
					await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${choice}`);
					await expect(
						page.getByRole('link', { name: new RegExp(`${visible} issue`) })
					).toBeVisible();
					if (absent) {
						await expect(
							page.getByRole('link', { name: new RegExp(`${absent} issue`) })
						).toHaveCount(0);
					} else {
						await expect(
							page.getByRole('link', { name: new RegExp(`${world.bName} issue`) })
						).toBeVisible();
					}
					expect(held.events.indexOf('patch-2-response')).toBeLessThan(
						held.events.indexOf('issues-request')
					);
					await expect
						.poll(async () => {
							const prefs = await body<UserPreferences>(
								await apiClient(request, ALICE.apiKey).get('/api/v1/preferences')
							);
							return prefs.focused_project_id;
						})
						.toBe(expectedId);
				} finally {
					held.releaseAll();
					await page.close();
				}
			}
		);
	}

	focusTest(
		'the switcher still moves the focus off a project page',
		async ({ browser, request, world }) => {
			// Regression (Tines/259 review): the project page announces its focus in
			// an effect, and a guard that read the optimistic hint made that hint a
			// dependency — so choosing anything in the switcher re-ran the effect and
			// PATCHed this project straight back, server-side and permanently.
			const page = await open(browser, DESKTOP, `/projects/${world.aId}`);
			await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.aName}`);
			const focusedId = async () =>
				(
					await body<UserPreferences>(
						await apiClient(request, ALICE.apiKey).get('/api/v1/preferences')
					)
				).focused_project_id;

			await chooseFocus(page, world.bName);
			await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.bName}`);
			expect(await focusedId()).toBe(world.bId);

			await chooseFocus(page, 'All projects');
			await expect(switcher(page)).toHaveAttribute('aria-label', 'Project focus: All projects');
			expect(await focusedId()).toBe(null);
			await page.close();
		}
	);

	focusTest(
		'targeted preference invalidation refreshes every resident focused loader',
		async ({ browser, request, world }) => {
			const api = apiClient(request, ALICE.apiKey);
			const extra = await api.post(`/api/v1/projects/${world.bId}/issues`, {
				title: `${world.bName} second issue`
			});
			expect(extra.status(), await extra.text()).toBe(201);
			const page = await open(browser, DESKTOP, `/issues?project=${world.aId}`);

			await chooseFocus(page, world.bName);
			await expect(
				page.getByRole('link', { name: new RegExp(`${world.bName} second issue`) })
			).toBeVisible();
			await expect(
				page.getByRole('link', { name: new RegExp(`${world.aName} issue`) })
			).toHaveCount(0);

			await gotoHydrated(page, '/context');
			await chooseFocus(page, world.aName);
			await expect(page.getByText(`${world.aName}-context`, { exact: true })).toBeVisible();
			await expect(page.getByText(`${world.bName}-context`, { exact: true })).toHaveCount(0);

			await gotoHydrated(page, '/activity');
			await chooseFocus(page, world.bName);
			await expect(page.locator(`a[href="/issues/${world.bName}/2"]`)).toBeVisible();
			await expect(page.locator(`a[href="/issues/${world.aName}/1"]`)).toHaveCount(0);

			await gotoHydrated(page, '/workflows');
			await chooseFocus(page, world.aName);
			await expect(page.locator('a[href="/workflows/wf_standard"]')).toContainText('1 open issue');

			await gotoHydrated(page, '/workflows/wf_standard');
			await chooseFocus(page, world.bName);
			await expect(
				page.getByText(`2 open issues in ${world.bName} use this workflow`)
			).toBeVisible();

			await gotoHydrated(page, '/agents');
			await chooseFocus(page, world.aName);
			const rules = page.getByRole('list', { name: 'Routing rules' });
			await expect(rules.getByText(world.aName, { exact: true })).toBeVisible();
			await expect(rules.getByText(world.bName, { exact: true })).toHaveCount(0);
			await page.close();
		}
	);

	focusTest('creating a project focuses it', async ({ browser, uniqueName, world }) => {
		const name = uniqueName('focus-c');
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
		focusTest(
			`archiving the focused project falls back to All projects, for good on ${label}`,
			async ({ browser, request, world }) => {
				const api = apiClient(request, ALICE.apiKey);
				const page = await open(
					browser,
					viewport,
					`/issues?project=${encodeURIComponent(world.bName)}`
				);
				await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.bName}`);

				expect((await api.post(`/api/v1/projects/${world.bId}/archive`)).ok()).toBe(true);
				await page.reload();
				await expect(switcher(page)).toHaveAttribute('aria-label', 'Project focus: All projects');
				await clickToOpen(
					switcher(page),
					page.getByRole('menuitemradio', { name: 'All projects' })
				);
				await expect(page.getByRole('menuitemradio', { name: world.bName })).toHaveCount(0);
				await page.keyboard.press('Escape');

				// The pointer was cleared, so thawing the project does not bring it back.
				expect((await api.post(`/api/v1/projects/${world.bId}/unarchive`)).ok()).toBe(true);
				await page.reload();
				await expect(switcher(page)).toHaveAttribute('aria-label', 'Project focus: All projects');
				await page.close();
			}
		);
	}

	focusTest(
		'issue detail rejects an archived stale hint in favor of live server focus',
		async ({ browser, request, world }) => {
			const api = apiClient(request, ALICE.apiKey);
			const page = await open(browser, DESKTOP, `/projects/${world.bId}`);
			try {
				await expect
					.poll(async () => {
						const prefs = await body<UserPreferences>(await api.get('/api/v1/preferences'));
						return prefs.focused_project_id;
					})
					.toBe(world.bId);

				// Move the persisted preference without touching the client hint. The
				// following in-app archive refreshes the live list and server focus while
				// deliberately leaving the old optimistic B hint in memory.
				expect(
					(await api.patch('/api/v1/preferences', { focused_project_id: world.aId })).ok()
				).toBe(true);
				const archiveButton = page.getByRole('button', { name: 'Archive project' });
				await clickToOpen(page.getByRole('button', { name: 'Settings' }), archiveButton);
				await archiveButton.click();
				await page
					.getByRole('alertdialog')
					.getByRole('button', { name: 'Archive project' })
					.click();

				await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${world.aName}`);
				// Stay inside the hydrated app so the deliberately stale B hint survives
				// both navigations. A full-document page.goto would reset the module-level
				// hint and let this pass without the issue-detail live-list validation.
				await page.getByRole('link', { name: 'Issues', exact: true }).first().click();
				const issue = page.getByRole('link', { name: new RegExp(`${world.aName} issue`) });
				await expect(issue).toBeVisible();
				await issue.click();
				await expect(page).toHaveURL(`/issues/${encodeURIComponent(world.aName)}/1`);
				await expect(page.getByRole('button', { name: `Focus ${world.aName}` })).toHaveCount(0);
				await expect(
					page.locator('main').getByRole('link', { name: 'Issues', exact: true })
				).toHaveAttribute('href', '/issues');
			} finally {
				await api.post(`/api/v1/projects/${world.bId}/unarchive`);
				await page.close();
			}
		}
	);

	for (const [label, viewport] of [
		['desktop', DESKTOP],
		['phone', PHONE]
	] as const) {
		focusTest(
			`in-app archive drops the optimistic focused project on ${label}`,
			async ({ browser, request, world }) => {
				const api = apiClient(request, ALICE.apiKey);
				const page = await open(browser, viewport, `/projects/${world.bId}`);
				try {
					await expect
						.poll(async () => {
							const prefs = await body<UserPreferences>(await api.get('/api/v1/preferences'));
							return prefs.focused_project_id;
						})
						.toBe(world.bId);

					const archiveButton = page.getByRole('button', { name: 'Archive project' });
					await clickToOpen(page.getByRole('button', { name: 'Settings' }), archiveButton);
					await archiveButton.click();
					await page
						.getByRole('alertdialog')
						.getByRole('button', { name: 'Archive project' })
						.click();

					await expect(page.getByText(/^Archived /)).toBeVisible();
					await expect(switcher(page)).toHaveAttribute('aria-label', 'Project focus: All projects');
					await clickToOpen(
						switcher(page),
						page.getByRole('menuitemradio', { name: 'All projects' })
					);
					await expect(page.getByRole('menuitemradio', { name: world.bName })).toHaveCount(0);
					await page.keyboard.press('Escape');

					const nav = label === 'phone' ? page.getByRole('navigation', { name: 'Primary' }) : page;
					await nav.getByRole('link', { name: 'Issues', exact: true }).click();
					await expect(
						page.getByRole('link', { name: new RegExp(`${world.aName} issue`) })
					).toBeVisible();
					await expect(
						page.getByRole('link', { name: new RegExp(`${world.bName} issue`) })
					).toHaveCount(0);
					await expect
						.poll(async () => {
							const prefs = await body<UserPreferences>(await api.get('/api/v1/preferences'));
							return prefs.focused_project_id;
						})
						.toBe(null);

					await gotoHydrated(page, `/issues/${encodeURIComponent(world.bName)}/1`);
					await expect(
						page.locator('main').getByRole('link', { name: 'Issues', exact: true })
					).toHaveAttribute('href', '/issues');
					await expect(page.getByRole('button', { name: `Focus ${world.bName}` })).toHaveCount(0);
				} finally {
					await api.post(`/api/v1/projects/${world.bId}/unarchive`);
					await page.close();
				}
			}
		);
	}

	focusTest('a run key cannot read or move its owner’s focus', async ({ request, world }) => {
		const api = apiClient(request, RUNROW.runKey);
		for (const res of [
			await api.get('/api/v1/preferences'),
			await api.patch('/api/v1/preferences', { focused_project_id: world.aId })
		]) {
			expect(res.status()).toBe(403);
		}
	});

	focusTest(
		'a run key’s issue list is unscoped whatever its owner is focused on',
		async ({ request, world }) => {
			// The focus is a UI scope, never a data one: set one over the API, then
			// read the list back with a run key and see both projects’ issues.
			const alice = apiClient(request, ALICE.apiKey);
			expect(
				(await alice.patch('/api/v1/preferences', { focused_project_id: world.aId })).ok()
			).toBe(true);

			const res = await apiClient(request, RUNROW.runKey).get('/api/v1/issues?limit=100');
			expect(res.status(), await res.text()).toBe(200);
			const titles = (await body<{ items: { title: string }[] }>(res)).items.map((i) => i.title);
			expect(titles).toContain(`${world.aName} issue`);
			expect(titles).toContain(`${world.bName} issue`);
		}
	);
});

test.describe.serial('project controls at every project count', () => {
	// Carol exists precisely for this: no live projects of her own, and no other
	// spec creates any for her. This spec archives its fixtures after each run.
	async function carol(browser: Browser): Promise<Page> {
		const context = await browser.newContext({ viewport: DESKTOP });
		await signIn(context, CAROL.sessionToken);
		const page = await context.newPage();
		await gotoHydrated(page, '/issues');
		return page;
	}

	test('offers actions at zero and one project, then shows focus at two', async ({
		browser,
		request,
		uniqueName
	}) => {
		test.setTimeout(60_000);
		const api = apiClient(request, CAROL.apiKey);
		const page = await carol(browser);
		const projectIds: string[] = [];
		try {
			const initialPreferences = await body<UserPreferences>(await api.get('/api/v1/preferences'));
			expect(initialPreferences.focused_project_id).toBe(null);
			expect(initialPreferences.last_project_id).toBe(null);

			await expect(switcher(page)).toContainText('Projects');
			await switcher(page).click();
			await expect(page.getByRole('menuitemradio')).toHaveCount(0);
			const manage = page.getByRole('menuitem', { name: 'Manage projects' });
			await expect(manage).toBeFocused();
			await expect(manage).toHaveAttribute('href', '/projects');
			await expect(page.getByRole('menuitem', { name: 'New project' })).toHaveAttribute(
				'href',
				'/projects?new=1'
			);
			await page.keyboard.press('Escape');
			await expect(switcher(page)).toBeFocused();

			// New project activates from another page and consumes the one-shot query.
			await switcher(page).click();
			const projectMenu = page.getByRole('menu', { name: 'Project focus' });
			const newProject = page.getByRole('menuitem', { name: 'New project' });
			await expect(newProject).toHaveAttribute('href', '/projects?new=1');
			await newProject.click();
			const newProjectDialog = page.getByRole('dialog', { name: 'New project' });
			await expect(newProjectDialog).toBeVisible();
			await expect(projectMenu).toBeHidden();
			await expect(page).toHaveURL('/projects');
			await newProjectDialog.getByRole('button', { name: 'Cancel' }).dispatchEvent('click');
			// Hidden precedes the dialog focus scope's teardown. Wait for removal so
			// its delayed close autofocus cannot interrupt the later menu-key journey.
			await expect(newProjectDialog).toHaveCount(0);
			await gotoHydrated(page, '/issues');

			// An archived-only account still exposes project management and its
			// archived inventory without adding a focus choice.
			const archived = await body<Project>(
				await api.post('/api/v1/projects', { name: uniqueName('carol-archived') })
			);
			projectIds.push(archived.id);
			expect((await api.post(`/api/v1/projects/${archived.id}/archive`)).ok()).toBe(true);
			await gotoHydrated(page, '/issues');
			await switcher(page).click();
			await page.getByRole('menuitem', { name: 'Manage projects' }).click();
			await expect(page).toHaveURL('/projects');
			await gotoHydrated(page, '/projects');
			const showArchived = page.getByRole('checkbox', { name: /^Show archived \(\d+\)$/ });
			await clickUntil(showArchived, async () => {
				await expect(page).toHaveURL('/projects?archived=1');
			});
			await gotoHydrated(page, '/projects?archived=1');
			await expect(page.getByRole('link', { name: archived.name })).toBeVisible();
			await expect(newProjectDialog).toHaveCount(0);

			const first = await body<Project>(
				await api.post('/api/v1/projects', { name: uniqueName('carol-1') })
			);
			projectIds.push(first.id);
			await gotoHydrated(page, '/issues');
			await expect(switcher(page)).toContainText('Projects');
			await switcher(page).click();
			await expect(page.getByRole('menuitemradio')).toHaveText(['All projects', first.name]);
			await expect(page.getByRole('menuitemradio', { name: 'All projects' })).toBeFocused();
			await expect(page.getByRole('menuitem', { name: 'Open project' })).toHaveCount(0);
			await page.getByRole('menuitemradio', { name: first.name }).click();
			await expect(switcher(page)).toHaveAttribute('aria-label', `Project focus: ${first.name}`);
			await expect(switcher(page)).toContainText('Projects');
			// The focus PATCH invalidates this layout. Wait for the closing portal to
			// detach before reopening, otherwise its late focus cleanup can steal focus
			// from the newly opened menu under a loaded CI worker.
			await expect(projectMenu).toHaveCount(0);
			const allProjects = page.getByRole('menuitemradio', { name: 'All projects' });
			const firstProject = page.getByRole('menuitemradio', { name: first.name });
			await clickToOpen(switcher(page), firstProject);
			await expect(firstProject).toBeFocused();
			const openProject = page.getByRole('menuitem', { name: 'Open project' });
			const lastAction = page.getByRole('menuitem', { name: 'New project' });
			await expect(openProject).toHaveAttribute('href', `/projects/${first.id}`);

			// Every movement key crosses the radio/action boundary, including both wraps.
			await pressProjectMenuKey(page, 'ArrowDown', firstProject, openProject);
			await pressProjectMenuKey(page, 'ArrowUp', openProject, firstProject);
			await pressProjectMenuKey(page, 'Home', firstProject, allProjects);
			await pressProjectMenuKey(page, 'ArrowUp', allProjects, lastAction);
			await pressProjectMenuKey(page, 'ArrowDown', lastAction, allProjects);
			await pressProjectMenuKey(page, 'End', allProjects, lastAction);
			await page.keyboard.press('Escape');

			// One project still behaves as the focus for New issue.
			await gotoHydrated(page, '/issues');
			await clickToOpen(page.getByRole('button', { name: 'New issue' }), page.getByRole('dialog'));
			await expect(page.getByRole('dialog').getByLabel('Project', { exact: true })).toHaveValue(
				first.id
			);
			await page.keyboard.press('Escape');

			await switcher(page).click();
			await openProject.click();
			await expect(page).toHaveURL(`/projects/${first.id}`);
			await expect(page.getByRole('heading', { name: first.name, level: 1 })).toBeVisible();

			const second = await body<Project>(
				await api.post('/api/v1/projects', { name: uniqueName('carol-2') })
			);
			projectIds.push(second.id);
			await gotoHydrated(page, '/issues');
			await expect(switcher(page)).toContainText(first.name);
		} finally {
			await runCleanupSteps([
				{
					name: 'reset Carol focus',
					run: async () => {
						const res = await api.patch('/api/v1/preferences', {
							focused_project_id: null,
							last_project_id: null
						});
						expect(res.ok()).toBe(true);
					}
				},
				{
					name: 'close Carol browser context',
					run: () => page.context().close()
				},
				...projectIds.map((id) => ({
					name: `archive Carol project ${id}`,
					run: async () => {
						expect((await api.post(`/api/v1/projects/${id}/archive`)).ok()).toBe(true);
					}
				}))
			]);
		}
	});
});
