import type { IssueDetail, Project } from '@tines/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, clickUntil, runId, signIn } from './helpers';

// This file exercises the animation itself; the suite default is reduced
// motion (playwright.config.ts). The reduced-motion tests below still call
// page.emulateMedia({ reducedMotion: 'reduce' }) per test, which overrides
// this file-level setting. See e2e/README.md.
test.use({ reducedMotion: 'no-preference' });

// Named to sort after `artifacts-panel.spec.ts`, not for tidiness: that spec's
// desktop row-wrap assertion depends on the relative-age string in the row's
// meta line, so ~11s of extra suite time ahead of it tips "less than a minute"
// over into a longer wording and wraps the row. Filed separately; until it is
// fixed, a spec inserted ahead of it alphabetically fails it.
//
// The AlertDialog animates with tw-animate-css utilities behind the
// `data-open:` / `data-closed:` variants that `app.css` defines against
// bits-ui's `data-state`. Nothing about the class list can tell a live
// animation from a dead one — the classes are identical either way — so these
// assert the *computed* animation-name, which is `none` whenever the variant
// selector fails to match (Tines/110).

const projectName = `alertanim-${runId}`;
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
			title: `Alert dialog animation ${runId}`,
			description: 'Fixture for the AlertDialog animation assertions.'
		})
	);
	await request.dispose();
});

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

/**
 * Deleting a comment is the cheapest route to a real AlertDialog: it is the
 * shared `confirmDialog()`, so whatever holds here holds for every dialog in
 * the app. Leaves the dialog open — the caller dismisses it.
 */
async function openConfirmDialog(page: Page): Promise<Locator> {
	const api = apiClient(page.request, ALICE.apiKey);
	const commentBody = `Animation fixture ${Date.now().toString(36)}`;
	await api.post(`/api/v1/issues/${issue.id}/comments`, { body: commentBody });

	await page.goto(`/issues/${encodeURIComponent(projectName)}/${issue.number}`);
	const comment = page.locator('article').filter({ hasText: commentBody }).first();
	await expect(comment).toBeVisible();

	const dialog = page.getByRole('alertdialog');
	await clickUntil(comment.getByRole('button', { name: 'Delete comment' }), async () => {
		await expect(dialog).toBeVisible({ timeout: 2_000 });
	});
	return dialog;
}

const animationName = (locator: Locator) =>
	locator.evaluate((el) => getComputedStyle(el).animationName);

test('the open alert dialog runs its enter animation', async ({ page }) => {
	const dialog = await openConfirmDialog(page);

	// `enter` is tw-animate-css's `animate-in` keyframes; `none` is what a
	// variant selector that matches nothing leaves behind.
	expect(await animationName(dialog)).toBe('enter');
	expect(await animationName(page.locator('[data-slot="alert-dialog-overlay"]'))).toBe('enter');

	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
});

// The pair matters: `none` is also what a dialog that never animated reports,
// so this assertion only means something alongside the test above. The
// in-test `emulateMedia` overrides this file's `test.use` opt-out.
test('a reduced-motion preference suppresses the alert dialog animation', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const dialog = await openConfirmDialog(page);

	expect(await animationName(dialog)).toBe('none');
	expect(await animationName(page.locator('[data-slot="alert-dialog-overlay"]'))).toBe('none');

	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
});
