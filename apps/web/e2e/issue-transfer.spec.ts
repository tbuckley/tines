import type { IssueDetail, Project } from '@tines/shared';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, clickToOpen, gotoHydrated, resetFocus, runId, signIn } from './helpers';

// Specs share one user: a project page sets the focus (Tines/259), so clear it
// before each test rather than letting it scope a later spec's lists.
test.beforeEach(async ({ request }) => {
	await resetFocus(request);
});

/**
 * "Move to project…" in the browser (Tines/392): choose a destination, inspect
 * the review, cancel with nothing written, then confirm and land on the
 * issue's new canonical address — at desktop and phone widths.
 *
 * Each viewport seeds its own source and destination projects, and the
 * destination already holds an issue, so the number the move allocates is
 * demonstrably the destination's next one and not the number carried over.
 */
function suite(label: string, viewport: { width: number; height: number }) {
	test.describe.serial(`issue transfer (${label})`, () => {
		const sourceName = `xf-src-${label}-${runId}`;
		const destinationName = `xf-dst-${label}-${runId}`;
		const longName = `xf-${label}-` + 'destination'.repeat(17);
		let issueId: string;
		let sourceId: string;
		let sourceNumber: number;
		let longId: string;

		async function open(browser: Browser, path: string): Promise<Page> {
			const context = await browser.newContext({ viewport });
			await signIn(context, ALICE.sessionToken);
			const page = await context.newPage();
			await gotoHydrated(page, path);
			return page;
		}

		test('seeds an occupied destination and an issue with a record', async ({ request }) => {
			const api = apiClient(request, ALICE.apiKey);
			const source = await body<Project>(
				await api.post('/api/v1/projects', { name: sourceName, description: 'move from here' })
			);
			sourceId = source.id;
			const destination = await body<Project>(
				await api.post('/api/v1/projects', { name: destinationName, description: 'move to here' })
			);
			longId = (await body<Project>(await api.post('/api/v1/projects', { name: longName }))).id;
			// The destination's first number is taken, so the move cannot keep
			// the issue's old one.
			await body<IssueDetail>(
				await api.post(`/api/v1/projects/${destination.id}/issues`, { title: 'already here' })
			);
			// Guidance the issue loses, guidance it gains: the review has to
			// name both.
			await api.post('/api/v1/context', {
				kind: 'prompt',
				name: `source-only-${label}`,
				project_id: source.id,
				body: 'Guidance that stays behind'
			});
			await api.post('/api/v1/context', {
				kind: 'prompt',
				name: `destination-only-${label}`,
				project_id: destination.id,
				body: 'Guidance the issue picks up'
			});
			const issue = await body<IssueDetail>(
				await api.post(`/api/v1/projects/${source.id}/issues`, {
					title: `${sourceName} traveller`,
					description: 'Carries its whole record'
				})
			);
			issueId = issue.id;
			sourceNumber = issue.number;
			await api.post(`/api/v1/issues/${issue.id}/comments`, { body: 'a comment that survives' });
		});

		test('focuses the chooser and contains a long unbroken destination', async ({ browser }) => {
			const page = await open(browser, `/issues/${sourceName}/${sourceNumber}`);
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			const chooser = modal.getByTestId('transfer-destination');
			await expect(chooser).toBeFocused();
			await chooser.selectOption(longId);
			await modal.getByRole('button', { name: 'Review move' }).click();
			const heading = modal.getByRole('heading', { level: 3 });
			await expect(heading).toBeFocused();
			await expect(heading).toContainText(longName);
			expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
				true
			);
			await modal.getByRole('button', { name: 'Cancel' }).click();
			await page.close();
		});

		test('shows a busy run and its actionable remedy', async ({ browser }) => {
			const page = await open(browser, `/issues/${sourceName}/${sourceNumber}`);
			await page.route('**/api/v1/issues/*/transfer?*', async (route) => {
				const response = await route.fetch();
				const preview = await response.json();
				await route.fulfill({
					response,
					json: {
						...preview,
						can_commit: false,
						preview_token: null,
						blockers: [
							{
								code: 'issue_busy',
								message: 'Run arun_busy is running; wait for it to finish or cancel it separately',
								run_id: 'arun_busy',
								run_status: 'running',
								remedy: 'tines runs show arun_busy'
							}
						]
					}
				});
			});
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			await modal.getByTestId('transfer-destination').selectOption({ label: destinationName });
			await modal.getByRole('button', { name: 'Review move' }).click();
			await expect(modal.getByTestId('transfer-blocker')).toContainText('arun_busy');
			await expect(modal.getByTestId('transfer-blocker')).toContainText(
				'tines runs show arun_busy'
			);
			await expect(modal.getByTestId('transfer-confirm')).toBeDisabled();
			await page.close();
		});

		test('reviews, inspects and cancels without writing anything', async ({ browser, request }) => {
			const page = await open(browser, `/issues/${sourceName}/${sourceNumber}`);
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);

			await modal.getByTestId('transfer-destination').selectOption({ label: destinationName });
			await modal.getByRole('button', { name: 'Review move' }).click();
			const review = page.getByTestId('transfer-review');
			await expect(review).toBeVisible();

			// The review names both addresses, the record it preserves, and the
			// guidance each side of the move.
			await expect(review).toContainText(`${sourceName}/${sourceNumber}`);
			await expect(review).toContainText(destinationName);
			await expect(review).toContainText('1 comments');
			await expect(review).toContainText(`source-only-${label}`);
			await expect(review).toContainText(`destination-only-${label}`);

			// Each guidance item is inspectable in place: opening one shows the
			// scope it moves between rather than a bare name.
			const item = review.locator('details').first();
			await item.locator('summary').click();
			await expect(item).toContainText('→');
			await expect(item).toContainText(/Guidance (that stays behind|the issue picks up)/);

			await modal.getByRole('button', { name: 'Cancel' }).click();
			await expect(modal).toHaveCount(0);

			// A cancelled review allocates no number and records no event: the
			// issue is still at its old address.
			const api = apiClient(request, ALICE.apiKey);
			const still = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			expect(still.project_name).toBe(sourceName);
			expect(still.number).toBe(sourceNumber);
			await page.close();
		});

		test('confirms the move and stays on the new canonical address', async ({
			browser,
			request
		}) => {
			const page = await open(browser, `/issues/${sourceName}/${sourceNumber}`);
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			await modal.getByTestId('transfer-destination').selectOption({ label: destinationName });
			await modal.getByRole('button', { name: 'Review move' }).click();
			await expect(page.getByTestId('transfer-review')).toBeVisible();
			await page.getByTestId('transfer-confirm').click();

			// The destination's number is its next one (its first is taken), and
			// the browser lands on that canonical URL without leaving the issue.
			await expect(page).toHaveURL(new RegExp(`/issues/${destinationName}/2$`));
			await expect(page.getByRole('heading', { name: `${sourceName} traveller` })).toBeVisible();
			await expect(page.getByText('a comment that survives')).toBeVisible();

			// The record and the identity survive; only the address changed.
			const api = apiClient(request, ALICE.apiKey);
			const moved = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			expect(moved.project_name).toBe(destinationName);
			expect(moved.number).toBe(2);
			expect(moved.id).toBe(issueId);

			// The old address still reaches it, and the browser canonicalises.
			const alias = await body<IssueDetail>(
				await api.get(`/api/v1/projects/${sourceId}/issues/${sourceNumber}`)
			);
			expect(alias.id).toBe(issueId);
			await gotoHydrated(page, `/issues/${sourceName}/${sourceNumber}?keep=1#activity`);
			await expect(page).toHaveURL(new RegExp(`/issues/${destinationName}/2\\?keep=1#activity$`));

			// The issue's own project no longer offers itself as a destination.
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			const options = await modal
				.getByTestId('transfer-destination')
				.locator('option')
				.allTextContents();
			expect(options).not.toContain(destinationName);
			expect(options).toContain(sourceName);
			await page.close();
		});

		test('never offers an archived project, and refuses one archived mid-review', async ({
			browser,
			request
		}) => {
			// The issue now lives in the destination; its old source is the one
			// this test archives.
			const api = apiClient(request, ALICE.apiKey);
			const page = await open(browser, `/issues/${destinationName}/2`);
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			const chooser = modal.getByTestId('transfer-destination');
			await chooser.selectOption({ label: sourceName });
			await modal.getByRole('button', { name: 'Review move' }).click();
			await expect(page.getByTestId('transfer-review')).toBeVisible();

			// Archived under the open review: confirming is refused with the
			// server's own reason, and nothing moves.
			await api.post(`/api/v1/projects/${sourceId}/archive`, {});
			await page.getByTestId('transfer-confirm').click();
			await expect(modal.getByRole('alert').filter({ hasText: /archived/i })).toBeVisible();
			const still = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			expect(still.project_name).toBe(destinationName);
			expect(still.number).toBe(2);

			// And an archived project is not offered as a destination at all.
			await modal.getByRole('button', { name: 'Cancel' }).click();
			await gotoHydrated(page, `/issues/${destinationName}/2`);
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			expect(await chooser.locator('option').allTextContents()).not.toContain(sourceName);

			await api.post(`/api/v1/projects/${sourceId}/unarchive`, {});
			await page.close();
		});

		test('asks again when the guidance changes under a review', async ({ browser, request }) => {
			const page = await open(browser, `/issues/${destinationName}/2`);
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			await modal.getByTestId('transfer-destination').selectOption({ label: sourceName });
			await modal.getByRole('button', { name: 'Review move' }).click();
			await expect(page.getByTestId('transfer-review')).toBeVisible();

			// Someone adds guidance at the destination after the review was read.
			const api = apiClient(request, ALICE.apiKey);
			const late = await body<{ id: string }>(
				await api.post('/api/v1/context', {
					kind: 'prompt',
					name: `late-guidance-${label}-${runId}`,
					project_id: sourceId,
					body: 'added after the review'
				})
			);

			await page.getByTestId('transfer-confirm').click();
			// Refused and refreshed, not reposted: the operator confirms the
			// guidance that is true now.
			await expect(page.getByTestId('transfer-stale')).toBeVisible();
			await expect(page.getByTestId('transfer-review')).toContainText(
				`late-guidance-${label}-${runId}`
			);
			const midway = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			expect(midway.project_name).toBe(destinationName);

			// The refreshed review commits on a second, deliberate confirmation.
			await page.getByTestId('transfer-confirm').click();
			await expect(page).toHaveURL(new RegExp(`/issues/${sourceName}/\\d+$`));
			const moved = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			expect(moved.project_name).toBe(sourceName);
			expect(moved.id).toBe(issueId);
			await api.delete(`/api/v1/context/${late.id}`);
			await page.close();
		});

		test('contains focus, closes on Escape and writes nothing', async ({ browser, request }) => {
			const api = apiClient(request, ALICE.apiKey);
			const before = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			const page = await open(browser, `/issues/${before.project_name}/${before.number}`);
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);

			// Tab walks the dialog's own controls and never escapes to the page.
			for (let i = 0; i < 8; i++) {
				await page.keyboard.press('Tab');
				expect(await modal.evaluate((el) => el.contains(document.activeElement))).toBe(true);
			}
			await page.keyboard.press('Shift+Tab');
			await page.keyboard.press('Escape');
			await expect(modal).toHaveCount(0);

			// Escape is a cancellation: the address is untouched.
			const after = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			expect(after.project_name).toBe(before.project_name);
			expect(after.number).toBe(before.number);
			await page.close();
		});

		test('recovers when the commit response is lost after the move', async ({
			browser,
			request
		}) => {
			const api = apiClient(request, ALICE.apiKey);
			const before = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			const target = before.project_name === sourceName ? destinationName : sourceName;
			const page = await open(browser, `/issues/${before.project_name}/${before.number}`);
			await page.route('**/api/v1/issues/*/transfer', async (route) => {
				if (route.request().method() !== 'POST') return route.continue();
				const response = await route.fetch();
				await response.body();
				await route.abort('failed');
			});
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			await modal.getByTestId('transfer-destination').selectOption({ label: target });
			await modal.getByRole('button', { name: 'Review move' }).click();
			await modal.getByTestId('transfer-confirm').click();
			await expect(modal.getByRole('alert')).toContainText('may have completed');
			await modal.getByRole('button', { name: 'Check current issue' }).click();
			const moved = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			await expect(page).toHaveURL(
				new RegExp(`/issues/${encodeURIComponent(moved.project_name)}/${moved.number}$`)
			);
			await page.close();
		});
	});
}

suite('desktop', { width: 1440, height: 900 });
suite('phone', { width: 390, height: 844 });
