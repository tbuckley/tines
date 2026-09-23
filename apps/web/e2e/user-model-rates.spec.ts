import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { gotoHydrated, signIn } from './helpers';

test.describe('user-entered model rates', () => {
	test.beforeEach(async ({ context }) => signIn(context, ALICE.sessionToken));

	test('adds a rate with copy-from and removes it from settings', async ({ page }) => {
		const model = `e2e-user-model-${Date.now()}`;
		await gotoHydrated(page, '/agents');
		await page.getByRole('button', { name: 'Add rate', exact: true }).click();
		await expect(page.getByRole('heading', { name: `Add rate for a model` })).toBeVisible();
		await page.getByRole('textbox', { name: 'Model' }).fill(model);
		await page.locator('#rate-copy').selectOption('gpt-5.6-sol');
		await expect(page.locator('#rate-input')).toHaveValue('4');
		await page.getByRole('button', { name: 'Save rate', exact: true }).click();
		await expect(page.getByText(model, { exact: false })).toBeVisible();
		const row = page.locator('li').filter({ hasText: model });
		await row.getByRole('button', { name: 'Remove', exact: true }).click();
		await expect(row).toBeHidden();
	});
});
