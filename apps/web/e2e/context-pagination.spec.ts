import { expect, test } from './fixtures';
import { CONTEXT_PAGINATION } from './constants.mjs';
import { gotoHydrated, signIn } from './helpers';

test.describe('context page pagination', () => {
	test.beforeEach(async ({ context }) => {
		await signIn(context, CONTEXT_PAGINATION.sessionToken);
	});

	test('steps through the context list and resets on a filter', async ({ page }) => {
		await gotoHydrated(page, '/context');
		const above = page.getByRole('navigation', { name: 'Context pagination above results' });
		const rows = page.locator('li:not([inert])');
		await expect(page.getByText('100 items on this page')).toHaveCount(2);
		await expect(rows.getByText('page-prompt-101', { exact: true })).toBeVisible();
		await expect(rows.getByText('page-prompt-001', { exact: true })).toHaveCount(0);
		await expect(page.getByLabel('Filter by kind').locator('option:checked')).toHaveText(
			'All except artifacts'
		);

		await above.getByRole('link', { name: 'Next' }).click();
		await expect(page).toHaveURL(/after=.*page_scope=all/);
		await expect(page.getByText('1 item on this page')).toHaveCount(2);
		await expect(rows.getByText('page-prompt-001', { exact: true })).toBeVisible();
		await expect(rows.getByText('page-prompt-101', { exact: true })).toHaveCount(0);

		await above.getByRole('link', { name: 'Previous' }).click();
		await expect(page).toHaveURL(/before=.*page_scope=all/);
		await expect(rows.getByText('page-prompt-101', { exact: true })).toBeVisible();
		await expect(rows.getByText('page-prompt-001', { exact: true })).toHaveCount(0);

		// A filter change on a later page starts again from the first page.
		await above.getByRole('link', { name: 'Next' }).click();
		await expect(rows.getByText('page-prompt-001', { exact: true })).toBeVisible();
		await page.getByLabel('Filter by kind').selectOption('prompt');
		await expect(page).toHaveURL(/kind=prompt/);
		await expect(page).not.toHaveURL(/after=|before=|page_scope=/);
		await expect(rows.getByText('page-prompt-101', { exact: true })).toBeVisible();
	});
});
