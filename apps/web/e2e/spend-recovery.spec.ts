import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { SPEND } from './constants.mjs';
import { gotoHydrated, signIn } from './helpers';

const spendUrl = (workflow = 'all') =>
	`/agents?agents_view=spend&spend_project=${SPEND.projects.alpha.id}&spend_window=7d&spend_view=workflow&spend_sort=desc&spend_workflow=${workflow}`;
const projectTotal = (page: Page) => page.locator('.statement strong').first();
const usageProject = (url: string) => new URL(url).searchParams.get('project');

/**
 * A released response resolves in the page's own microtask queue, so a bare
 * negative assertion passes on its first poll before the stale report could
 * have been adopted. Wait for the body to arrive, then give the component two
 * frames: a missing generation fence renders the stale report within them.
 */
async function settle(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}

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
		await gotoHydrated(page, spendUrl());
		await expect(page.getByText(/Spend unavailable: controlled failure/)).toBeVisible();
		await page.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect(projectTotal(page)).toHaveText('$5.00');
		await page.getByRole('button', { name: 'Refresh' }).click();
		await expect(page.getByText(/Refresh failed — showing the report generated/)).toBeVisible();
		await expect(projectTotal(page)).toHaveText('$5.00');
		expect(calls).toBe(3);
	});

	test('keeps workflow narrowing correctable while the initial request fails', async ({ page }) => {
		let calls = 0;
		await page.route('**/api/v1/usage?**', async (route) => {
			calls++;
			if (calls === 1)
				await route.fulfill({ status: 500, json: { error: { message: 'controlled failure' } } });
			else await route.continue();
		});
		await gotoHydrated(page, spendUrl(SPEND.workflows.build.id));
		await expect(page.getByText(/Spend unavailable: controlled failure/)).toBeVisible();
		// The scope that failed must stay visible and changeable without a reload.
		const narrowing = page.getByLabel('Workflow narrowing');
		await expect(narrowing).toBeVisible();
		await expect(narrowing).toHaveValue(SPEND.workflows.build.id);
		await narrowing.selectOption('all');
		await expect(projectTotal(page)).toHaveText('$5.00');
		await expect(page.getByText(/Spend unavailable/)).toBeHidden();
	});

	test('hides the prior report when a newly selected scope fails', async ({ page }) => {
		await gotoHydrated(page, spendUrl());
		await expect(projectTotal(page)).toHaveText('$5.00');
		await page.route('**/api/v1/usage?**', async (route) => {
			if (usageProject(route.request().url()) === SPEND.projects.beta.id)
				await route.fulfill({ status: 500, json: { error: { message: 'beta failure' } } });
			else await route.continue();
		});
		await page.getByLabel('Spend project').selectOption(SPEND.projects.beta.id);
		await expect(page.getByText(/Spend unavailable: beta failure/)).toBeVisible();
		await expect(page.locator('.statement')).toBeHidden();
		await expect(page.getByText('$5.00', { exact: true })).toBeHidden();
	});

	test('ignores a delayed old selection after a newer project completes', async ({ page }) => {
		let releaseAlpha!: () => void;
		const alphaHeld = new Promise<void>((resolve) => (releaseAlpha = resolve));
		const finished: string[] = [];
		page.on('requestfinished', (request) => {
			if (request.url().includes('/api/v1/usage?'))
				finished.push(usageProject(request.url()) ?? 'all');
		});
		await page.route('**/api/v1/usage?**', async (route) => {
			if (usageProject(route.request().url()) === SPEND.projects.alpha.id) await alphaHeld;
			await route.continue();
		});
		await gotoHydrated(page, '/agents');
		await page.getByRole('button', { name: 'Analysis', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Spend' })).toBeVisible();
		await page.getByLabel('Spend project').selectOption(SPEND.projects.alpha.id);
		await page.getByLabel('Spend project').selectOption(SPEND.projects.beta.id);
		await expect(projectTotal(page)).toHaveText('$11.00');
		releaseAlpha();
		await expect
			.poll(() => finished.filter((id) => id === SPEND.projects.alpha.id))
			.toHaveLength(1);
		await settle(page);
		await expect(projectTotal(page)).toHaveText('$11.00');
		await expect(page.getByText('$5.00', { exact: true })).toBeHidden();
	});

	test('ignores a delayed old failure after a newer project completes', async ({ page }) => {
		let failAlpha!: () => void;
		const alphaHeld = new Promise<void>((resolve) => (failAlpha = resolve));
		const finished: string[] = [];
		page.on('requestfinished', (request) => {
			if (request.url().includes('/api/v1/usage?'))
				finished.push(usageProject(request.url()) ?? 'all');
		});
		await page.route('**/api/v1/usage?**', async (route) => {
			if (usageProject(route.request().url()) === SPEND.projects.alpha.id) {
				await alphaHeld;
				await route.fulfill({ status: 500, json: { error: { message: 'stale failure' } } });
				return;
			}
			await route.continue();
		});
		await gotoHydrated(page, '/agents?agents_view=spend');
		await expect(page.getByRole('heading', { name: 'Spend' })).toBeVisible();
		await page.getByLabel('Spend project').selectOption(SPEND.projects.alpha.id);
		await page.getByLabel('Spend project').selectOption(SPEND.projects.beta.id);
		await expect(projectTotal(page)).toHaveText('$11.00');
		failAlpha();
		await expect
			.poll(() => finished.filter((id) => id === SPEND.projects.alpha.id))
			.toHaveLength(1);
		await settle(page);
		await expect(page.getByText(/stale failure/)).toBeHidden();
		await expect(projectTotal(page)).toHaveText('$11.00');
	});

	test('drops a held request when Spend unmounts and reloads it on return', async ({ page }) => {
		let releaseAlpha!: () => void;
		const alphaHeld = new Promise<void>((resolve) => (releaseAlpha = resolve));
		let alphaCalls = 0;
		await page.route('**/api/v1/usage?**', async (route) => {
			if (usageProject(route.request().url()) === SPEND.projects.alpha.id && ++alphaCalls === 1) {
				await alphaHeld;
			}
			await route.continue();
		});
		// Only Alpha is held, and it is selected after hydration, so the hold
		// never blocks `gotoHydrated`'s network-idle wait.
		await gotoHydrated(page, '/agents?agents_view=spend');
		await expect(page.getByRole('heading', { name: 'Spend' })).toBeVisible();
		await page.getByLabel('Spend project').selectOption(SPEND.projects.alpha.id);
		await expect(page.getByText('Loading spend…')).toBeVisible();
		await page.getByRole('button', { name: 'Now', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Spend' })).toBeHidden();
		releaseAlpha();
		await settle(page);
		await page.getByRole('button', { name: 'Analysis', exact: true }).click();
		await expect(projectTotal(page)).toHaveText('$5.00');
		expect(alphaCalls).toBe(2);
	});

	test('ends a hung request at the deadline and recovers with Retry', async ({ page }) => {
		// The deadline is 30s of real time; nothing else in this file waits.
		test.setTimeout(120_000);
		let held = true;
		let alphaCalls = 0;
		await page.route('**/api/v1/usage?**', async (route) => {
			if (usageProject(route.request().url()) === SPEND.projects.alpha.id && held) {
				alphaCalls++;
				// Deliberately never settled: the panel's own deadline, not the
				// network, has to end this request.
				return;
			}
			await route.continue();
		});
		await gotoHydrated(page, '/agents?agents_view=spend');
		await expect(page.getByRole('heading', { name: 'Spend' })).toBeVisible();
		await page.getByLabel('Spend project').selectOption(SPEND.projects.alpha.id);
		await expect(page.getByText('Loading spend…')).toBeVisible();
		await expect(page.getByText(/Spend unavailable: The spend request timed out\./)).toBeVisible({
			timeout: 60_000
		});
		// No retry storm while the deadline runs, and no stuck spinner after it.
		expect(alphaCalls).toBe(1);
		await expect(page.getByText('Loading spend…')).toBeHidden();
		held = false;
		await page.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect(projectTotal(page)).toHaveText('$5.00');
	});

	test('ignores a delayed success and a delayed failure that land on an incomplete Custom range', async ({
		page
	}) => {
		let release!: () => void;
		let held = new Promise<void>((resolve) => (release = resolve));
		let mode: 'success' | 'failure' = 'success';
		const finished: string[] = [];
		page.on('requestfinished', (request) => {
			if (request.url().includes('/api/v1/usage?'))
				finished.push(new URL(request.url()).searchParams.get('window') ?? '');
		});
		await page.route('**/api/v1/usage?**', async (route) => {
			if (new URL(route.request().url()).searchParams.get('window') === '30d') {
				await held;
				if (mode === 'failure') {
					await route.fulfill({
						status: 500,
						json: { error: { message: 'stale custom failure' } }
					});
					return;
				}
			}
			await route.continue();
		});
		await gotoHydrated(page, spendUrl());
		await expect(projectTotal(page)).toHaveText('$5.00');

		await page.getByRole('button', { name: 'Last 30 days' }).click();
		await expect(page.getByText('Loading spend…')).toBeVisible();
		await page.getByRole('button', { name: 'Custom' }).click();
		await expect(page.locator('.spend .error')).toContainText(
			'Enter both From and To, then Apply.'
		);
		release();
		await expect.poll(() => finished.filter((window) => window === '30d')).toHaveLength(1);
		await settle(page);
		// The delayed 30d report must not be presented as the Custom scope.
		await expect(page.locator('.statement')).toBeHidden();
		await expect(page.locator('.spend .error')).toContainText(
			'Enter both From and To, then Apply.'
		);

		mode = 'failure';
		held = new Promise<void>((resolve) => (release = resolve));
		await page.getByRole('button', { name: 'Last 30 days' }).click();
		await expect(page.getByText('Loading spend…')).toBeVisible();
		await page.getByRole('button', { name: 'Custom' }).click();
		await expect(page.locator('.spend .error')).toContainText(
			'Enter both From and To, then Apply.'
		);
		release();
		await expect.poll(() => finished.filter((window) => window === '30d')).toHaveLength(2);
		await settle(page);
		await expect(page.getByText(/stale custom failure/)).toBeHidden();
		await expect(page.locator('.spend .error')).toContainText(
			'Enter both From and To, then Apply.'
		);

		// Still live: a complete selection loads normally afterwards.
		await page.getByRole('button', { name: 'Last 7 days' }).click();
		await expect(projectTotal(page)).toHaveText('$5.00');
	});
});
