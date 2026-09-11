import { expect, test } from '@playwright/test';
import { SPEND } from './constants.mjs';
import { gotoHydrated, signIn } from './helpers';

const spendUrl = `/agents?agents_view=spend&spend_project=${SPEND.projects.alpha.id}&spend_window=7d&spend_view=workflow&spend_sort=desc&spend_workflow=all`;
const projectTotal = (page: import('@playwright/test').Page) =>
	page.locator('.statement strong').first();

test.describe('Agents Spend recovery', () => {
	test.beforeEach(async ({ context }) => signIn(context, SPEND.sessionToken));

	test('recovers an initial failure and retains only a same-scope refresh report', async ({
		page
	}) => {
		let calls = 0;
		await page.route('**/api/v1/usage?**', async (route) => {
			calls++;
			if (calls === 1 || calls === 3)
				await route.fulfill({ status: 500, json: { error: { message: 'controlled failure' } } });
			else await route.continue();
		});
		await gotoHydrated(page, spendUrl);
		await expect(page.getByText(/Spend unavailable: controlled failure/)).toBeVisible();
		await page.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect(projectTotal(page)).toHaveText('$5.00');
		await page.getByRole('button', { name: 'Refresh' }).click();
		await expect(page.getByText(/Refresh failed — showing the report generated/)).toBeVisible();
		await expect(projectTotal(page)).toHaveText('$5.00');
		expect(calls).toBe(3);
	});

	test('ignores a delayed old selection after a newer project completes', async ({ page }) => {
		let releaseAlpha!: () => void;
		const alphaHeld = new Promise<void>((resolve) => (releaseAlpha = resolve));
		await page.route('**/api/v1/usage?**', async (route) => {
			const url = new URL(route.request().url());
			if (url.searchParams.get('project') === SPEND.projects.alpha.id) await alphaHeld;
			await route.continue();
		});
		await gotoHydrated(page, '/agents');
		await page.getByRole('button', { name: 'Spend', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Spend' })).toBeVisible();
		await page.getByLabel('Spend project').selectOption(SPEND.projects.alpha.id);
		await page.getByLabel('Spend project').selectOption(SPEND.projects.beta.id);
		await expect(projectTotal(page)).toHaveText('$11.00');
		releaseAlpha();
		await expect(projectTotal(page)).toHaveText('$11.00');
		await expect(page.getByText('$5.00', { exact: true })).toBeHidden();
	});
});
