import type { IssueDetail, Project } from '@tines/shared';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { body, gotoHydrated, resetFocus } from './helpers';

/**
 * Only the list row morphing to or from its issue page carries
 * view-transition names (lib/issue-morph.svelte.ts). The browser captures
 * each named element before a transition starts, so naming every row made a
 * 100-row list take hundreds of milliseconds to leave.
 */

let listUrl: string;
let issues: IssueDetail[];

test.beforeAll(async ({ apiFor, uniqueName }) => {
	const api = apiFor(ALICE);
	const name = uniqueName('issue-morph');
	listUrl = `/issues?project=${encodeURIComponent(name)}`;
	const project = await body<Project>(await api.post('/api/v1/projects', { name }));
	issues = [];
	for (const title of ['First morph issue', 'Second morph issue', 'Third morph issue']) {
		issues.push(
			await body<IssueDetail>(await api.post(`/api/v1/projects/${project.id}/issues`, { title }))
		);
	}
});

// The morph only runs with motion allowed; the suite defaults to reduced.
test.use({ signedIn: ALICE, reducedMotion: 'no-preference' });

test.beforeEach(async ({ request }) => {
	await resetFocus(request);
});

/**
 * Named list elements at the two moments the browser captures: when the
 * transition starts (the old page) and when it is ready (the new page).
 */
type Capture = { old: number; new: number };

async function recordCaptures(page: Page) {
	await page.addInitScript(() => {
		const named = () => document.querySelectorAll('main ul [style*="view-transition-name"]').length;
		const w = window as unknown as { __captures: { old: number; new: number }[] };
		w.__captures = [];
		const start = document.startViewTransition.bind(document);
		document.startViewTransition = ((update: () => Promise<void>) => {
			// The old page as it stands when the transition starts: what the
			// browser goes on to capture.
			const capture = { old: named(), new: -1 };
			w.__captures.push(capture);
			const transition = start(update);
			transition.ready.then(() => (capture.new = named())).catch(() => {});
			return transition;
		}) as typeof document.startViewTransition;
	});
}

/**
 * The capture for the navigation `act` starts, once its new page is ready.
 * The first one: an issue page can follow with a second, URL-only navigation.
 */
async function captureOf(page: Page, act: () => Promise<unknown>): Promise<Capture> {
	const before = await page.evaluate(
		() => (window as unknown as { __captures: unknown[] }).__captures.length
	);
	await act();
	const handle = await page.waitForFunction((n) => {
		const c = (window as unknown as { __captures: Capture[] }).__captures;
		return c.length > n && c[n].new >= 0 && c[n];
	}, before);
	return (await handle.jsonValue()) as Capture;
}

test('only the row that morphs to or from its issue page is named', async ({ page }) => {
	await recordCaptures(page);
	await gotoHydrated(page, listUrl);
	const row = page.getByRole('link', { name: /Second morph issue/ });
	await expect(row).toBeVisible();

	// Opening an issue names its row, and only its row, before the capture.
	expect(await captureOf(page, () => row.click())).toEqual({ old: 2, new: 0 });
	await expect(page).toHaveURL(new RegExp(`/${issues[1].number}$`));
	await page.waitForLoadState('networkidle');

	// Coming back, the list names the row the detail page morphs into.
	const back = page.locator('main a[href="/issues"]').first();
	expect(await captureOf(page, () => back.click())).toEqual({ old: 0, new: 2 });
	await page.waitForLoadState('networkidle');

	// Leaving for another tab names nothing in the list.
	const agents = page.locator('header nav a', { hasText: 'Agents' }).first();
	expect((await captureOf(page, () => agents.click())).old).toBe(0);
});
