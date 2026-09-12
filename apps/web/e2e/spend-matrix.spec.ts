import { expect, test, type Page } from '@playwright/test';
import { SPEND } from './constants.mjs';
import { d1 } from './d1';
import { spendRearmStatement } from './spend-seed.mjs';
import { gotoHydrated, signIn } from './helpers';

/** Seed and assertion share one anchor; see spend.spec.ts for why. */
function armLedgerDays(): number {
	const anchor = Date.now();
	d1(spendRearmStatement(anchor));
	return anchor;
}

function utcDate(offsetDays: number, anchor: number) {
	const date = new Date(anchor);
	date.setUTCHours(0, 0, 0, 0);
	date.setUTCDate(date.getUTCDate() + offsetDays);
	return date.toISOString().slice(0, 10);
}

const projectTotal = (page: Page) => page.locator('.statement strong').first();

const spendUrl = (extra: Record<string, string> = {}) => {
	const params = new URLSearchParams({
		agents_view: 'spend',
		spend_project: SPEND.projects.alpha.id,
		spend_window: '7d',
		spend_view: 'workflow',
		spend_sort: 'desc',
		spend_workflow: 'all',
		...extra
	});
	return `/agents?${params}`;
};

function usageRequests(page: Page) {
	const requests: URL[] = [];
	page.on('request', (request) => {
		if (request.url().includes('/api/v1/usage?')) requests.push(new URL(request.url()));
	});
	return requests;
}

test.describe('Agents Spend selection matrix', () => {
	test.beforeEach(async ({ context }) => signIn(context, SPEND.sessionToken));

	test('reloads an incomplete Custom URL without a request and accepts a correction', async ({
		page
	}) => {
		const anchor = armLedgerDays();
		const requests = usageRequests(page);
		await gotoHydrated(page, spendUrl({ spend_window: 'custom', spend_from: utcDate(-2, anchor) }));
		await expect(page.locator('.spend .error')).toContainText('Enter both From and To, then Apply.');
		await expect(page.locator('.statement')).toBeHidden();
		await expect(page.getByText('Loading spend…')).toBeHidden();
		expect(requests).toHaveLength(0);
		await expect(page.getByLabel('From')).toHaveValue(utcDate(-2, anchor));
		await page.getByRole('textbox', { name: 'To', exact: true }).fill(utcDate(-1, anchor));
		await page.getByRole('button', { name: 'Apply' }).click();
		await expect(projectTotal(page)).toHaveText('$3.00');
		expect(requests).toHaveLength(1);
	});

	test('clears applied Custom bounds when a preset is chosen', async ({ page }) => {
		const anchor = armLedgerDays();
		const requests = usageRequests(page);
		await gotoHydrated(
			page,
			spendUrl({
				spend_window: 'custom',
				spend_from: utcDate(-2, anchor),
				spend_to: utcDate(-1, anchor)
			})
		);
		await expect(projectTotal(page)).toHaveText('$3.00');
		await page.getByRole('button', { name: 'Last 30 days' }).click();
		await expect(projectTotal(page)).toHaveText('$12.00');
		await expect(page).not.toHaveURL(/spend_from=/);
		await expect(page).not.toHaveURL(/spend_to=/);
		expect(requests.at(-1)?.searchParams.get('window')).toBe('30d');
		expect(requests.at(-1)?.searchParams.has('from')).toBe(false);
		// Returning to Custom offers empty bounds rather than the cleared range.
		await page.getByRole('button', { name: 'Custom' }).click();
		await expect(page.getByLabel('From')).toHaveValue('');
		await expect(page.getByRole('textbox', { name: 'To', exact: true })).toHaveValue('');
	});

	test('restores sort direction through history without refetching', async ({ page }) => {
		armLedgerDays();
		const requests = usageRequests(page);
		await gotoHydrated(page, spendUrl({ spend_window: '30d' }));
		await expect(projectTotal(page)).toHaveText('$12.00');
		const rows = page.locator('.groups article');
		await expect(rows.nth(0)).toContainText('Ship');
		const loaded = requests.length;
		await page.getByRole('button', { name: 'Cost descending' }).click();
		await expect(rows.nth(0)).toContainText('Build');
		await expect(page).toHaveURL(/spend_sort=asc/);
		await page.goBack();
		await expect(page).toHaveURL(/spend_sort=desc/);
		await expect(page.getByRole('button', { name: 'Cost descending' })).toBeVisible();
		await expect(rows.nth(0)).toContainText('Ship');
		await expect(rows.nth(2)).toContainText('Unknown cost');
		await page.goForward();
		await expect(rows.nth(0)).toContainText('Build');
		await expect(rows.nth(2)).toContainText('Unknown cost');
		expect(requests).toHaveLength(loaded);
	});

	test('keeps an unrelated hash and query across filter changes', async ({ page }) => {
		armLedgerDays();
		await gotoHydrated(page, `${spendUrl({ unrelated: 'keep' })}#queue`);
		await expect(projectTotal(page)).toHaveText('$5.00');
		await page.getByRole('button', { name: 'Last 30 days' }).click();
		await expect(projectTotal(page)).toHaveText('$12.00');
		await expect(page).toHaveURL(/#queue$/);
		await expect(page).toHaveURL(/unrelated=keep/);
		await page.getByRole('button', { name: 'Starting state' }).click();
		await expect(page.getByRole('button', { name: /Design 1 finalized/ })).toBeVisible();
		await expect(page).toHaveURL(/#queue$/);
		await expect(page).toHaveURL(/unrelated=keep/);
	});

	test('holds explicit archived and All scope across a global focus change', async ({ page }) => {
		armLedgerDays();
		const requests = usageRequests(page);
		await gotoHydrated(
			page,
			spendUrl({ spend_project: SPEND.projects.archived.id, spend_window: 'today' })
		);
		await expect(projectTotal(page)).toHaveText('$17.00');
		expect(requests.at(-1)?.searchParams.get('project')).toBe(SPEND.projects.archived.id);
		await page.getByLabel('Spend project').selectOption('all');
		await expect(projectTotal(page)).toHaveText('$30.00');
		expect(requests.at(-1)?.searchParams.has('project')).toBe(false);
		// A global focus change must not silently re-scope an explicit Spend selection.
		await page.getByLabel('Spend project').selectOption(SPEND.projects.alpha.id);
		await expect(projectTotal(page)).toHaveText('$2.00');
		await page.goBack();
		await expect(page.getByLabel('Spend project')).toHaveValue('all');
		await expect(projectTotal(page)).toHaveText('$30.00');
	});

	test('settles on the latest of two rapid different-key changes', async ({ page }) => {
		armLedgerDays();
		const requests = usageRequests(page);
		await gotoHydrated(page, spendUrl({ spend_window: '30d' }));
		await expect(projectTotal(page)).toHaveText('$12.00');
		const before = requests.length;
		await page.getByRole('button', { name: 'Today' }).click();
		await page.getByLabel('Spend project').selectOption(SPEND.projects.beta.id);
		await expect(projectTotal(page)).toHaveText('$11.00');
		await expect(page).toHaveURL(/spend_window=today/);
		await expect(page).toHaveURL(new RegExp(`spend_project=${SPEND.projects.beta.id}`));
		await expect(page.getByRole('button', { name: 'Today' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		const last = requests.at(-1)!;
		expect(last.searchParams.get('window')).toBe('today');
		expect(last.searchParams.get('project')).toBe(SPEND.projects.beta.id);
		expect(requests.length).toBeLessThanOrEqual(before + 2);
	});
});
