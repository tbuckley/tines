import { expect, test } from '@playwright/test';
import { PAGINATION } from './constants.mjs';
import { gotoHydrated, PHONE, signIn } from './helpers';

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
		await page.getByRole('textbox', { name: 'Search issues' }).fill('Page issue 105');
		await page.getByRole('textbox', { name: 'Search issues' }).press('Enter');
		await expect(page).toHaveURL(/q=Page(?:\+|%20)issue(?:\+|%20)105/);
		await expect(page).not.toHaveURL(/(?:after|before|page_scope)=/);
		await expect(page.getByText('Page issue 105', { exact: true })).toBeVisible();

		await gotoHydrated(page, bounded);
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

	test('stale-page recovery is a full phone tap target without overflow', async ({ page }) => {
		await page.setViewportSize(PHONE);
		const staleCursor = btoa('0:iss_stale_boundary');

		for (const path of [
			`/issues?after=${staleCursor}`,
			`/projects/${PAGINATION.projectId}?after=${staleCursor}`
		]) {
			await page.goto(path);
			await expect(
				page.getByText('No issues on this page. Results may have changed.')
			).toBeVisible();

			const recovery = page.getByRole('link', { name: 'First page' });
			await expect(recovery).toBeVisible();
			const box = await recovery.boundingBox();
			expect(box).not.toBeNull();
			expect(box!.height).toBeGreaterThanOrEqual(44);
			expect(box!.width).toBeGreaterThanOrEqual(44);
			expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
				)
			).toBe(true);
		}
	});
});
