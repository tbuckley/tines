import { expect, test } from '@playwright/test';
import { SPEND } from './constants.mjs';
import { armLedgerDays } from './spend-arm';
import { gotoHydrated, signIn } from './helpers';

test.describe('Agents completed-issue costs', () => {
	test.beforeEach(async ({ context }) => signIn(context, SPEND.sessionToken));

	test('restores terminal selection and walks issue, cutoff-run, and entry evidence', async ({
		page
	}) => {
		await armLedgerDays();
		await gotoHydrated(
			page,
			`/agents?agents_view=spend&spend_project=${SPEND.projects.alpha.id}&spend_window=30d&spend_view=workflow&spend_sort=desc&spend_workflow=all`
		);
		await page.getByRole('button', { name: 'Completed issues' }).click();
		await expect(page).toHaveURL(/spend_mode=cohort/);
		const cohort = page.locator('.cohort');
		await cohort.getByLabel('Workflow').selectOption(SPEND.workflows.build.id);
		await expect(cohort.getByLabel('Closed')).toBeChecked();
		await expect(cohort.getByLabel('Canceled')).toBeChecked();
		await expect(cohort.getByText('3 completed issues')).toBeVisible();
		await expect(cohort.getByText('1 reopened · 0 unknown')).toBeVisible();
		await expect(cohort.getByText(/1 no-run/)).toBeVisible();

		await cohort.getByRole('button', { name: 'View completed issues' }).click();
		await expect(page).toHaveURL(/spend_kind=issues/);
		await expect(cohort.getByText('Spend completed without a run')).toBeVisible();
		await expect(
			cohort.getByText(/Closed at .*not reopened in available history/).first()
		).toBeVisible();
		await cohort.getByRole('button', { name: 'Lifetime through now' }).first().click();
		await expect(cohort.getByRole('heading', { name: 'Lifetime through now' })).toBeVisible();
		await cohort.getByRole('button', { name: /Alpha\/5 Spend completed without a run/ }).click();
		await expect(page).toHaveURL(/spend_kind=runs/);
		await expect(cohort.getByText('No contributing runs.')).toBeVisible();

		await cohort.getByRole('button', { name: 'Issues', exact: true }).click();
		await cohort.getByRole('button', { name: 'View entry history' }).click();
		await expect(page).toHaveURL(/spend_kind=entries/);
		await expect(cohort.getByText('Completion entry history')).toBeVisible();
		await expect(cohort.getByText('Chosen', { exact: true })).toHaveCount(3);

		await cohort.getByLabel('Canceled').uncheck();
		await expect(page).toHaveURL(/spend_done_states=/);
		await expect(cohort.getByText('2 completed issues')).toBeVisible();
		await page.reload({ waitUntil: 'networkidle' });
		await expect(page.locator('.cohort').getByLabel('Canceled')).not.toBeChecked();
		await expect(page.locator('.cohort').getByText('2 completed issues')).toBeVisible();
	});

	test('keeps the completed-issue controls usable at desktop and phone widths', async ({
		page
	}) => {
		await armLedgerDays();
		const url = `/agents?agents_view=spend&spend_mode=cohort&spend_project=${SPEND.projects.alpha.id}&spend_window=30d&spend_view=workflow&spend_sort=desc&spend_workflow=all&spend_cohort_workflow=${SPEND.workflows.build.id}`;
		for (const width of [1440, 390, 320]) {
			await page.setViewportSize({ width, height: 900 });
			await gotoHydrated(page, url);
			const cohort = page.locator('.cohort');
			await expect(cohort.getByText('3 completed issues')).toBeVisible();
			await expect(cohort.getByRole('button', { name: 'View completed issues' })).toBeVisible();
			expect(
				await cohort.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
			).toBe(true);
		}
	});
});
