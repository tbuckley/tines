import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { SPEND } from './constants.mjs';
import { gotoHydrated, signIn } from './helpers';
import { armLedgerDays, utcDate } from './spend-arm';

const projectTotal = (page: Page) => page.locator('.statement strong').first();

/** Alpha, 7d, canonical — but with Now selected, so entry is a real tab change. */
const nowUrlWithSpendScope = (extra: Record<string, string> = {}) =>
	`/agents?${new URLSearchParams({
		spend_project: SPEND.projects.alpha.id,
		spend_window: '7d',
		spend_view: 'workflow',
		spend_sort: 'desc',
		spend_workflow: 'all',
		...extra
	})}`;

const focused = (locator: Locator) => locator.evaluate((el) => el === document.activeElement);

/** Walks the real tab order — no programmatic focus — and stops on `locator`. */
async function tabTo(page: Page, locator: Locator, max = 60) {
	await expect(locator).toBeVisible();
	for (let index = 0; index < max; index++) {
		if (await focused(locator)) return;
		await page.keyboard.press('Tab');
	}
	throw new Error(`Tab order never reached ${locator}`);
}

/**
 * Selects a `<select>` option by typing its label, with focus already on the
 * control. Arrow keys cannot do this portably: on Linux/Windows Chromium
 * ArrowDown moves a focused select's selection, but on macOS it is popup-only
 * and leaves the value untouched — which is how the earlier version of the
 * project step passed vacuously on macOS while failing on CI's Linux. Blink's
 * type-ahead is the one keyboard gesture both platforms treat as a direct
 * selection (the space in "Spend Beta" is consumed by the search rather than
 * opening the popup, because the buffer is already non-empty). That buffer
 * only clears after about a second of idle, so a second selection waits it out
 * first; the target must differ from the current value, so the step can never
 * assert what is already true.
 */
const TYPEAHEAD_RESET_MS = 1_200;

async function typeAheadSelect(page: Page, select: Locator, option: { id: string; name: string }) {
	expect(await select.inputValue()).not.toBe(option.id);
	for (let attempt = 0; ; attempt++) {
		await page.waitForTimeout(TYPEAHEAD_RESET_MS);
		await page.keyboard.type(option.name);
		try {
			await expect(select).toHaveValue(option.id, { timeout: 2_000 });
			return;
		} catch (error) {
			if (attempt > 0) throw error;
		}
	}
}

test.describe('Agents Spend keyboard and layout', () => {
	test.beforeEach(async ({ context }) => signIn(context, SPEND.sessionToken));

	test('drives tabs, filters, Apply, sort, Refresh and expansion from the keyboard', async ({
		page
	}) => {
		const anchor = await armLedgerDays();
		const requests: URL[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/v1/usage?')) requests.push(new URL(request.url()));
		});
		await gotoHydrated(page, nowUrlWithSpendScope());

		// Tab switch.
		const spendTab = page.getByRole('button', { name: 'Spend', exact: true });
		await tabTo(page, spendTab);
		await page.keyboard.press('Enter');
		await expect(page.getByRole('heading', { name: 'Spend' })).toBeVisible();
		await expect(page).toHaveURL(/agents_view=spend/);
		await expect(projectTotal(page)).toHaveText('$5.00');

		// Project select: keyboard only, and the change must reach the request.
		// Both directions are driven to a *different* project than the one already
		// selected, with independently expected totals (Beta's 7d ledger is its
		// single $11 run; its $13 run is ten days old), so neither step can pass
		// without a keyboard-driven change reaching the wire.
		const project = page.getByLabel('Spend project');
		await tabTo(page, project);
		const beforeBeta = requests.length;
		await typeAheadSelect(page, project, SPEND.projects.beta);
		await expect.poll(() => requests.length).toBeGreaterThan(beforeBeta);
		await expect
			.poll(() => requests.at(-1)?.searchParams.get('project'))
			.toBe(SPEND.projects.beta.id);
		await expect(projectTotal(page)).toHaveText('$11.00');
		await typeAheadSelect(page, project, SPEND.projects.alpha);
		await expect
			.poll(() => requests.at(-1)?.searchParams.get('project'))
			.toBe(SPEND.projects.alpha.id);
		await expect(projectTotal(page)).toHaveText('$5.00');

		// Period, and focus is restored to the control that was activated.
		const thirty = page.getByRole('button', { name: 'Last 30 days' });
		await tabTo(page, thirty);
		await page.keyboard.press('Enter');
		await expect(projectTotal(page)).toHaveText('$12.00');
		await expect(thirty).toHaveAttribute('aria-pressed', 'true');
		expect(await focused(thirty)).toBe(true);

		// Sort, both directions, Unknown last.
		const rows = page.locator('.groups article');
		const sort = page.getByRole('button', { name: /^Cost (des|as)cending$/ });
		await tabTo(page, sort);
		await page.keyboard.press('Enter');
		await expect(rows.nth(0)).toContainText('Build');
		await expect(rows.nth(2)).toContainText('Unknown cost');
		await tabTo(page, sort);
		await page.keyboard.press('Enter');
		await expect(rows.nth(0)).toContainText('Ship');
		await expect(rows.nth(2)).toContainText('Unknown cost');

		// Group expansion toggles from the keyboard.
		const group = rows.nth(0).getByRole('button').first();
		await tabTo(page, group);
		await page.keyboard.press('Enter');
		await expect(group).toHaveAttribute('aria-expanded', 'true');
		await expect(rows.nth(0).locator('.detail')).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(group).toHaveAttribute('aria-expanded', 'false');
		const expandAll = page.getByRole('button', { name: 'Expand all' });
		await tabTo(page, expandAll);
		await page.keyboard.press('Space');
		await expect(rows.locator('.detail')).toHaveCount(3);
		const collapseAll = page.getByRole('button', { name: 'Collapse all' });
		await expect(collapseAll).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(rows.locator('.detail')).toHaveCount(0);

		// Refresh, exactly once.
		const refresh = page.getByRole('button', { name: 'Refresh' });
		const loaded = requests.length;
		await tabTo(page, refresh);
		await page.keyboard.press('Enter');
		await expect.poll(() => requests.length).toBe(loaded + 1);
		await expect(projectTotal(page)).toHaveText('$12.00');

		// Custom: typed bounds, submitted with Enter from the To field.
		const custom = page.getByRole('button', { name: 'Custom' });
		await tabTo(page, custom);
		await page.keyboard.press('Enter');
		const from = page.getByLabel('From');
		await tabTo(page, from);
		await page.keyboard.type(utcDate(-2, anchor));
		await page.keyboard.press('Tab');
		await page.keyboard.type(utcDate(-1, anchor));
		await page.keyboard.press('Enter');
		await expect(projectTotal(page)).toHaveText('$3.00');
		expect(requests.at(-1)?.searchParams.get('from')).toBe(utcDate(-2, anchor));
	});

	test('retries a failed load from the keyboard', async ({ page }) => {
		await armLedgerDays();
		let calls = 0;
		await page.route('**/api/v1/usage?**', async (route) => {
			if (++calls === 1)
				await route.fulfill({ status: 500, json: { error: { message: 'controlled failure' } } });
			else await route.continue();
		});
		await gotoHydrated(page, nowUrlWithSpendScope({ agents_view: 'spend' }));
		await expect(page.getByText(/Spend unavailable: controlled failure/)).toBeVisible();
		const retry = page.getByRole('button', { name: 'Retry', exact: true });
		await tabTo(page, retry);
		await page.keyboard.press('Enter');
		await expect(projectTotal(page)).toHaveText('$5.00');
	});

	test('discloses mixed persisted rate evidence and restores the invoker at 320px', async ({
		page
	}) => {
		await armLedgerDays();
		await page.setViewportSize({ width: 320, height: 700 });
		await gotoHydrated(page, nowUrlWithSpendScope({ agents_view: 'spend' }));
		const estimate = page.getByRole('button', { name: 'Estimated' });
		await estimate.click();
		const dialog = page.getByRole('dialog', { name: 'Estimate basis' });
		await expect(dialog).toContainText('Provider: 3 USD (1 runs)');
		await expect(dialog).toContainText('spend-e2e-rate v7');
		await expect(dialog).toContainText('Rates per 1000000 tokens: input tokens 100000');
		await expect(dialog.getByRole('link', { name: 'Pricing source' })).toHaveAttribute(
			'href',
			'https://example.test/pricing'
		);
		expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
		await page.keyboard.press('Escape');
		await expect(estimate).toBeFocused();
		await estimate.click();
		await dialog.getByRole('button', { name: 'Close' }).click();
		await expect(estimate).toBeFocused();
	});

	for (const viewport of [
		{ name: 'desktop', width: 1440, height: 900 },
		{ name: 'phone', width: 390, height: 844 },
		{ name: 'narrow', width: 320, height: 700 }
	]) {
		test(`stays usable and unclipped at ${viewport.width}px`, async ({ page }) => {
			const anchor = await armLedgerDays();
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await gotoHydrated(page, nowUrlWithSpendScope({ agents_view: 'spend', spend_window: '30d' }));
			await expect(projectTotal(page)).toHaveText('$12.00');

			const overflow = async () =>
				page.evaluate(() => {
					const doc = document.documentElement;
					const panel = document.querySelector('.spend') as HTMLElement;
					return {
						document: doc.scrollWidth - doc.clientWidth,
						panel: panel.scrollWidth - panel.clientWidth
					};
				});
			expect(await overflow()).toEqual({ document: 0, panel: 0 });

			// Real interactions at this width, not only a static measurement.
			await page.getByRole('button', { name: 'Today' }).click();
			await expect(projectTotal(page)).toHaveText('$2.00');
			await page.getByRole('button', { name: 'Last 30 days' }).click();
			await expect(projectTotal(page)).toHaveText('$12.00');
			const group = page.locator('.groups article').first().getByRole('button').first();
			await group.click();
			await expect(page.locator('.groups article').first().locator('.detail')).toBeVisible();
			expect(await overflow()).toEqual({ document: 0, panel: 0 });

			// The longest labels the panel renders: All projects, and the raw-id
			// workflow fallback shown when no report can resolve a name.
			await page.getByLabel('Spend project').selectOption('all');
			await expect(projectTotal(page)).toHaveText('$53.00');
			await page.getByRole('button', { name: 'Custom' }).click();
			await page.getByLabel('From').fill(utcDate(-2, anchor));
			await page.getByRole('textbox', { name: 'To', exact: true }).fill(utcDate(-1, anchor));
			await page.getByRole('button', { name: 'Apply' }).click();
			await expect(projectTotal(page)).toHaveText('$3.00');
			expect(await overflow()).toEqual({ document: 0, panel: 0 });

			// Every toolbar control stays a usable target with legible text.
			const controls = await page.locator('.spend .toolbar button, .spend .toolbar select').all();
			expect(controls.length).toBeGreaterThan(5);
			for (const control of controls) {
				const box = await control.boundingBox();
				const size = await control.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
				expect(box, await control.textContent()).not.toBeNull();
				expect(box!.height, await control.textContent()).toBeGreaterThanOrEqual(24);
				expect(size, await control.textContent()).toBeGreaterThanOrEqual(11);
			}
		});
	}
});

// The suite runs reduced-motion by default (see playwright.config.ts); this
// proves the same sort under normal motion, where transitions actually play.
test.describe('Agents Spend under normal motion', () => {
	test.use({ reducedMotion: 'no-preference' });
	test.beforeEach(async ({ context }) => signIn(context, SPEND.sessionToken));

	test('sorts with Unknown last while transitions run', async ({ page }) => {
		await armLedgerDays();
		await gotoHydrated(page, nowUrlWithSpendScope({ agents_view: 'spend', spend_window: '30d' }));
		const rows = page.locator('.groups article');
		await expect(rows.nth(0)).toContainText('Ship');
		await page.getByRole('button', { name: 'Cost descending' }).click();
		await expect(rows.nth(0)).toContainText('Build');
		await expect(rows.nth(2)).toContainText('Unknown cost');
	});
});
