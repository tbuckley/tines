import { expect, test, type Page } from '@playwright/test';
import { SPEND } from './constants.mjs';
import { d1 } from './d1';
import { gotoHydrated, signIn } from './helpers';
import { armLedgerDays, utcDate } from './spend-arm';

/**
 * The pending fixture is the only seeded row the ordinary supervisor sweep can
 * finalize — any other spec firing `/__scheduled` times it out or fails it as
 * an offline local runner's — so the case re-arms both clocks immediately
 * before asserting rather than trusting seed-time timestamps.
 */
function armPendingRun() {
	const now = Date.now();
	d1(`UPDATE runner SET last_seen_at = ${now} WHERE id = 'rnr_e2e_spend'`);
	d1(
		`UPDATE agent_run SET status = 'running', outcome = NULL, ended_at = NULL, started_at = ${now}, created_at = ${now} WHERE id = 'run_e2e_spend_pending'`
	);
}

async function selectProject(page: Page, name: string) {
	const project = Object.values(SPEND.projects).find((candidate) => candidate.name === name)!;
	await page.getByLabel('Spend project').selectOption({ label: name });
	await expect(page.getByLabel('Spend project')).toHaveValue(project.id);
}

const projectTotal = (page: Page) => page.locator('.statement strong').first();

test.describe('Agents Spend real ledger', () => {
	test.beforeEach(async ({ context }) => signIn(context, SPEND.sessionToken));

	test('enters from Now and keeps tabs, primary filters, URL and real totals synchronized', async ({
		page
	}) => {
		await armLedgerDays();
		const requests: URL[] = [];
		const errors: Error[] = [];
		page.on('pageerror', (error) => errors.push(error));
		page.on('request', (request) => {
			if (request.url().includes('/api/v1/usage?')) requests.push(new URL(request.url()));
		});
		await gotoHydrated(page, '/agents?unrelated=keep');
		await expect(page.getByRole('button', { name: 'Now', exact: true })).toHaveAttribute(
			'aria-current',
			'page'
		);
		await page.getByRole('button', { name: 'Spend', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Spend' })).toBeVisible();
		await expect(page).toHaveURL(/unrelated=keep/);
		await expect(projectTotal(page)).toHaveText('$33.00');
		expect(requests.at(-1)?.searchParams.get('window')).toBe('7d');

		await selectProject(page, SPEND.projects.alpha.name);
		await expect(projectTotal(page)).toHaveText('$5.00');
		expect(requests.at(-1)?.searchParams.get('project')).toBe(SPEND.projects.alpha.id);
		await page.getByRole('button', { name: 'Today' }).click();
		await expect(projectTotal(page)).toHaveText('$2.00');
		expect(requests.at(-1)?.searchParams.get('window')).toBe('today');
		await page.getByRole('button', { name: 'Last 30 days' }).click();
		await expect(projectTotal(page)).toHaveText('$12.00');
		await page.getByRole('button', { name: 'Starting state' }).click();
		await expect(page.getByRole('button', { name: /Design 1 finalized/ })).toBeVisible();
		expect(requests.at(-1)?.searchParams.get('by')).toBe('state');
		await page.getByRole('button', { name: 'Outcome' }).click();
		await expect(page.getByRole('button', { name: /Advanced 1 finalized/ })).toBeVisible();
		await page.getByLabel('Workflow narrowing').selectOption({ label: 'Build' });
		await expect(page.getByText(/Matching subtotal: \$5\.00/)).toBeVisible();
		expect(requests.at(-1)?.searchParams.get('workflow')).toBe(SPEND.workflows.build.id);
		await selectProject(page, SPEND.projects.beta.name);
		await expect(page.getByLabel('Workflow narrowing')).toHaveValue('all');
		await expect(projectTotal(page)).toHaveText('$24.00');

		await page.getByRole('button', { name: 'Now', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Spend' })).toBeHidden();
		await page.getByRole('button', { name: 'Spend', exact: true }).click();
		await expect(projectTotal(page)).toHaveText('$24.00');
		expect(errors).toEqual([]);
	});

	test('applies Custom ranges, marks drafts dirty, and restores bounds through history', async ({
		page
	}) => {
		const anchor = await armLedgerDays();
		const requests: URL[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/v1/usage?')) requests.push(new URL(request.url()));
		});
		await gotoHydrated(
			page,
			`/agents?agents_view=spend&spend_project=${SPEND.projects.alpha.id}&spend_window=30d&spend_view=workflow&spend_sort=desc&spend_workflow=all`
		);
		await expect(projectTotal(page)).toHaveText('$12.00');
		await page.getByRole('button', { name: 'Custom' }).click();
		await expect(page.getByText('Enter both From and To, then Apply.')).toBeVisible();
		const beforeApply = requests.length;
		await page.getByLabel('From').fill(utcDate(-2, anchor));
		await page.getByRole('textbox', { name: 'To', exact: true }).fill(utcDate(-1, anchor));
		expect(requests).toHaveLength(beforeApply);
		await page.getByRole('button', { name: 'Apply' }).click();
		await expect(projectTotal(page)).toHaveText('$3.00');
		expect(requests.at(-1)?.searchParams.get('from')).toBe(utcDate(-2, anchor));
		expect(requests.at(-1)?.searchParams.get('to')).toBe(utcDate(-1, anchor));

		await page.getByLabel('From').fill(utcDate(-10, anchor));
		await expect(page.getByText('Unapplied changes — Apply to update.')).toBeVisible();
		await expect(projectTotal(page)).toHaveText('$3.00');
		await page.getByRole('textbox', { name: 'To', exact: true }).fill(utcDate(-9, anchor));
		await page.getByRole('button', { name: 'Apply' }).click();
		await expect(projectTotal(page)).toHaveText('$7.00');
		await page.goBack();
		await expect(page.getByLabel('From')).toHaveValue(utcDate(-2, anchor));
		await expect(projectTotal(page)).toHaveText('$3.00');
		await page.goForward();
		await expect(page.getByLabel('From')).toHaveValue(utcDate(-10, anchor));
		await expect(projectTotal(page)).toHaveText('$7.00');
		await page.getByLabel('From').fill(utcDate(1, anchor));
		await page.getByRole('textbox', { name: 'To', exact: true }).fill(utcDate(0, anchor));
		await page.getByRole('button', { name: 'Apply' }).click();
		await expect(page.getByText(/Spend unavailable:/)).toBeVisible();
		await expect(page.locator('.custom .error')).toContainText(/From must be before To|future/i);
		await expect(page.locator('.statement')).toBeHidden();
	});

	test('sorts unknown last without refetch and refreshes exactly once', async ({ page }) => {
		await armLedgerDays();
		const requests: URL[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/v1/usage?')) requests.push(new URL(request.url()));
		});
		await gotoHydrated(
			page,
			`/agents?agents_view=spend&spend_project=${SPEND.projects.alpha.id}&spend_window=30d&spend_view=workflow&spend_sort=desc&spend_workflow=all`
		);
		await expect(projectTotal(page)).toHaveText('$12.00');
		const rows = page.locator('.groups article');
		await expect(rows.nth(0)).toContainText('Ship');
		await expect(rows.nth(2)).toContainText('Unknown cost');
		const loaded = requests.length;
		await page.getByRole('button', { name: 'Cost descending' }).click();
		await expect(rows.nth(0)).toContainText('Build');
		await expect(rows.nth(2)).toContainText('Unknown cost');
		expect(requests).toHaveLength(loaded);
		await page.getByRole('button', { name: 'Refresh' }).click();
		await expect.poll(() => requests.length).toBe(loaded + 1);
		await expect(projectTotal(page)).toHaveText('$12.00');
	});

	test('renders empty, pending, unreported, token-only, measured-zero and partial states', async ({
		page
	}) => {
		await armLedgerDays();
		await gotoHydrated(
			page,
			`/agents?agents_view=spend&spend_project=${SPEND.projects.empty.id}&spend_window=today&spend_view=workflow&spend_sort=desc&spend_workflow=all`
		);
		await expect(page.getByText(/No runs — no finalized runs/)).toBeVisible();
		armPendingRun();
		await selectProject(page, SPEND.projects.pending.name);
		await expect(page.getByText(/No finalized runs yet — 1 pending/)).toBeVisible();
		await selectProject(page, SPEND.projects.unreported.name);
		await expect(page.getByText(/Unknown — 1 unreported/)).toBeVisible();
		await selectProject(page, SPEND.projects.tokens.name);
		await expect(page.getByText(/Unknown dollars — 1 unpriced and 0 unreported/)).toBeVisible();
		await selectProject(page, SPEND.projects.zero.name);
		await expect(projectTotal(page)).toHaveText('$0');
		await selectProject(page, SPEND.projects.alpha.name);
		await expect(page.locator('.statement p').filter({ hasText: /partial/ })).toContainText(
			/partial\s*·\s*2 finalized\s*·\s*1 priced\s*·\s*0 unpriced\s*·\s*1 unreported/i
		);
	});
});
