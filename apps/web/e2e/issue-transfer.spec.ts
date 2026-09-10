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
		let issueId: string;
		let sourceId: string;
		let sourceNumber: number;

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
			await gotoHydrated(page, `/issues/${sourceName}/${sourceNumber}`);
			await expect(page).toHaveURL(new RegExp(`/issues/${destinationName}/2$`));

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
	});
}

suite('desktop', { width: 1440, height: 900 });
suite('phone', { width: 390, height: 844 });
