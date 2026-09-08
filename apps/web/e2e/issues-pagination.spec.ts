import { expect, test } from '@playwright/test';
import { PAGINATION } from './constants.mjs';
import { gotoHydrated, signIn } from './helpers';

test.describe('issue list pagination', () => {
	test.beforeEach(async ({ context }) => {
		await signIn(context, PAGINATION.user.sessionToken);
	});

	test('steps through the focused issues list and resets on a filter', async ({ page }) => {
		await gotoHydrated(page, `/issues?project=${PAGINATION.projectName}`);
		await expect(page.getByText('100 issues on this page')).toBeVisible();
		await expect(page.getByText('Page issue 205', { exact: true })).toBeVisible();
		await expect(page.getByText('Page issue 105', { exact: true })).toHaveCount(0);

		await page.getByRole('link', { name: 'Next' }).click();
		await expect(page).toHaveURL(/after=.*page_scope=prj_e2e_pagination/);
		await expect(page.getByText('Page issue 105', { exact: true })).toBeVisible();
		const bounded = page.url();
		await page.reload();
		await expect(page).toHaveURL(bounded);
		await expect(page.getByText('Page issue 105', { exact: true })).toBeVisible();

		await page.getByRole('link', { name: 'Previous' }).click();
		await expect(page.getByText('Page issue 205', { exact: true })).toBeVisible();
		await page.getByRole('link', { name: /^Active/ }).click();
		await expect(page).not.toHaveURL(/(?:after|before|page_scope)=/);
		await expect(page.getByText('Page issue 205', { exact: true })).toBeVisible();
	});

	test('paginates the project issues section and rejects malformed boundaries', async ({
		page
	}) => {
		await gotoHydrated(page, `/projects/${PAGINATION.projectId}`);
		await page.getByRole('link', { name: 'Next' }).click();
		await expect(page).toHaveURL(/\/projects\/prj_e2e_pagination\?after=/);
		await expect(page.getByText('Page issue 105', { exact: true })).toBeVisible();
		expect((await page.goto('/issues?after=one&before=two'))?.status()).toBe(400);
	});
});
