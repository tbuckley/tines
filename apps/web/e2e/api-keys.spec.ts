import { expect, test, type Page } from '@playwright/test';
import { ALICE, RUNROW, RUNROW_FAILED } from './constants.mjs';
import { signIn } from './helpers';

/**
 * The API keys page folds run keys — one is minted per agent run and never
 * deleted — out of the list the user manages. The seed gives Alice one key of
 * her own (`alice-key`), one *active* run key (RUNROW's, still authenticating
 * for api.spec.ts's fence cases) and one *revoked* run key (RUNROW_FAILED's).
 *
 * Never confirm Revoke on RUNROW's run key: api.spec.ts authenticates with it
 * and the suite shares one D1.
 */

const PHONE = { width: 390, height: 844 };

/** The list of the user's own keys — the first `<ul>` on the page. */
const userKeyList = (page: Page) => page.locator('ul').first();
const disclosure = (page: Page) => page.getByTestId('run-keys');
/**
 * Rows are located by *runner* name: both seeded runs are on the same issue,
 * so the issue ref alone matches two rows — which is the point of naming a run
 * key after its run rather than after a key name.
 */
const runKeyRow = (page: Page, runnerName: string) =>
	disclosure(page).locator('li').filter({ hasText: runnerName });

const activeRunRef = `run on ${RUNROW.projectName}/${RUNROW.issueNumber}`;

/**
 * Open the disclosure. `bind:open` re-asserts its initial value when hydration
 * lands, so a click in the SSR-to-hydration window is undone — the same race
 * `clickUntil` exists for elsewhere in the suite (see theme.spec.ts).
 */
async function openDisclosure(page: Page): Promise<void> {
	const details = disclosure(page);
	await expect(async () => {
		if (!(await details.evaluate((el: HTMLDetailsElement) => el.open))) {
			await details.locator('summary').click();
		}
		expect(await details.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);
		// Held across a beat, so a hydration snap-back fails the attempt.
		await page.waitForTimeout(250);
		expect(await details.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);
	}).toPass({ timeout: 15_000 });
}

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

test.describe.serial('API keys page', () => {
	test("the user's own keys are the whole visible list", async ({ page }) => {
		await page.goto('/settings/api-keys');
		await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();

		const own = userKeyList(page);
		await expect(own.getByText(ALICE.apiKeyName, { exact: true })).toBeVisible();
		// No run key has leaked into the list the user manages.
		await expect(own.getByText(/^run/)).toHaveCount(0);
		await expect(own.getByText(RUNROW.runnerName)).toHaveCount(0);
	});

	test('run keys sit in a disclosure that is closed by default and counts both populations', async ({
		page
	}) => {
		await page.goto('/settings/api-keys');

		const details = disclosure(page);
		await expect(details).toBeVisible();
		await expect(details.locator('summary')).toContainText('Run keys');
		// One active (RUNROW), one revoked (RUNROW_FAILED) — the whole point of
		// the split: the counts are of run keys only, not of the user's keys.
		await expect(details.locator('summary')).toContainText('1 active, 1 revoked');
		expect(await details.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
		// Closed means its contents are not rendered to the user.
		await expect(details.getByText(activeRunRef)).toBeHidden();
	});

	test('opening it names each run key by the issue its run worked, and links there', async ({
		page
	}) => {
		await page.goto('/settings/api-keys');
		await openDisclosure(page);

		const row = runKeyRow(page, RUNROW.runnerName);
		await expect(row).toHaveCount(1);
		await expect(row.getByRole('link', { name: activeRunRef })).toHaveAttribute(
			'href',
			`/issues/${RUNROW.projectName}/${RUNROW.issueNumber}`
		);
		// The runner is what a human recognises; the prefix still identifies the key.
		await expect(row).toContainText(RUNROW.runnerName);
		await expect(row).toContainText(RUNROW.runKey.slice(0, 14));
		// The run id is available on hover without spending a line on it.
		await expect(row.locator('p').first()).toHaveAttribute('title', new RegExp(RUNROW.runId));

		// The revoked run key is hidden until asked for.
		await expect(disclosure(page).getByText(RUNROW_FAILED.runnerName)).toHaveCount(0);
	});

	test('"Show revoked" reveals the revoked run key and survives a reload', async ({ page }) => {
		await page.goto('/settings/api-keys');
		await openDisclosure(page);

		await disclosure(page).getByLabel('Show revoked').check();
		await expect(page).toHaveURL(/revoked=1/);

		// The disclosure stays open across the navigation that flips the param.
		const details = disclosure(page);
		expect(await details.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);

		const revokedRow = runKeyRow(page, RUNROW_FAILED.runnerName);
		await expect(revokedRow).toHaveCount(1);
		await expect(revokedRow).toContainText('revoked');
		// A revoked key can never act again, so it carries no action.
		await expect(revokedRow.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
		// Both seeded runs worked the same issue, so both rows carry its ref —
		// the label names the run, not the key.
		await expect(revokedRow).toContainText(activeRunRef);
		await expect(runKeyRow(page, RUNROW.runnerName)).toHaveCount(1);

		// Arriving at the URL directly opens the disclosure with the box ticked.
		await page.goto('/settings/api-keys?revoked=1');
		expect(await disclosure(page).evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);
		await expect(disclosure(page).getByLabel('Show revoked')).toBeChecked();
		await expect(runKeyRow(page, RUNROW_FAILED.runnerName)).toHaveCount(1);

		// Unticking drops the param and hides it again.
		await disclosure(page).getByLabel('Show revoked').uncheck();
		await expect(page).not.toHaveURL(/revoked=1/);
		await expect(runKeyRow(page, RUNROW_FAILED.runnerName)).toHaveCount(0);
	});

	test('revoking a live run key warns that it cuts the agent off mid-run', async ({ page }) => {
		await page.goto('/settings/api-keys');
		await openDisclosure(page);

		await runKeyRow(page, RUNROW.runnerName).getByRole('button', { name: 'Revoke' }).click();

		// The shared confirm is bits-ui's alert-dialog variant: role="alertdialog".
		const dialog = page.getByRole('alertdialog');
		await expect(dialog).toContainText(`${RUNROW.projectName}/${RUNROW.issueNumber}`);
		await expect(dialog).toContainText(RUNROW.runnerName);
		await expect(dialog).toContainText(/cuts the agent off mid-run/i);

		// Cancel — api.spec.ts's fence cases authenticate with this key.
		await dialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(dialog).toBeHidden();
		await expect(
			runKeyRow(page, RUNROW.runnerName).getByRole('button', { name: 'Revoke' })
		).toHaveCount(1);
	});

	test('on a phone the user reaches their own key and the fold without scrolling', async ({
		page
	}) => {
		await page.setViewportSize(PHONE);
		await page.goto('/settings/api-keys');

		await expect(userKeyList(page).getByText(ALICE.apiKeyName, { exact: true })).toBeInViewport({
			ratio: 1
		});
		await expect(disclosure(page).locator('summary')).toBeInViewport({ ratio: 1 });
	});
});
