import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { SPEND } from './constants.mjs';
import { d1 } from './d1';
import { apiClient, body, gotoHydrated, signIn } from './helpers';
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
		await page.getByRole('button', { name: 'Analysis', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Spend' })).toBeVisible();
		await expect(page).toHaveURL(/unrelated=keep/);
		await expect(projectTotal(page)).toHaveText('$33.00');
		expect(requests.at(-1)?.searchParams.get('window')).toBe('7d');

		await selectProject(page, SPEND.projects.alpha.name);
		await expect(projectTotal(page)).toHaveText('$5.00');
		expect(requests.at(-1)?.searchParams.get('project')).toBe(SPEND.projects.alpha.id);
		await page.getByRole('button', { name: 'Today', exact: true }).click();
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
		await page.getByRole('button', { name: 'Analysis', exact: true }).click();
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
		await expect(rows.nth(2)).toContainText(SPEND.workflows.unknown.name);
		const loaded = requests.length;
		await page.getByRole('button', { name: 'Cost descending' }).click();
		await expect(rows.nth(0)).toContainText('Build');
		await expect(rows.nth(2)).toContainText(SPEND.workflows.unknown.name);
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

	test('opens frozen issue and run evidence and restores it through reload and history', async ({
		page
	}) => {
		await armLedgerDays();
		await gotoHydrated(
			page,
			`/agents?agents_view=spend&spend_project=${SPEND.projects.alpha.id}&spend_window=30d&spend_view=workflow&spend_sort=desc&spend_workflow=all`
		);
		await expect(projectTotal(page)).toHaveText('$12.00');
		await page.getByRole('button', { name: 'View contributing issues and runs' }).first().click();
		await expect(page.getByRole('heading', { name: 'Contributing issues' })).toBeVisible();
		await expect(page.getByText('Whole selection: $12.00 · 4 issues')).toBeVisible();
		await page.getByRole('button', { name: 'Today', exact: true }).click();
		await expect(projectTotal(page)).toHaveText('$2.00');
		await expect(page.getByRole('heading', { name: 'Contributing issues' })).toBeHidden();
		await page.getByRole('button', { name: 'Last 30 days' }).click();
		await expect(projectTotal(page)).toHaveText('$12.00');
		await page.getByRole('button', { name: 'View contributing issues and runs' }).first().click();
		await page.reload({ waitUntil: 'networkidle' });
		await expect(page.getByRole('heading', { name: 'Contributing issues' })).toBeVisible();
		await page.getByRole('button', { name: /Alpha\/3 Spend alpha_10d/ }).click();
		await expect(page).toHaveURL(/spend_kind=runs/);
		await expect(page.getByRole('heading', { name: 'Contributing runs' })).toBeVisible();
		await expect(page.getByText('run_e2e_spend_alpha_10d', { exact: true })).toBeVisible();
		await page.getByText('Accounting details for run_e2e_spend_alpha_10d').click();
		await expect(page.locator('.accounting p').first()).toContainText(
			/priced\s*·\s*source provider\s*·\s*exact cost 7/
		);
		await expect(page.getByText(/Tokens: input tokens/)).toBeVisible();
		await page.goBack();
		await expect(page.getByRole('heading', { name: 'Contributing issues' })).toBeVisible();
		await page.getByRole('button', { name: /Alpha\/1 Spend alpha_today/ }).click();
		await page.getByText('Accounting details for run_e2e_spend_alpha_today').click();
		const accounting = page.locator('.accounting');
		await expect(accounting).toContainText('Tokens: input tokens 20');
		await expect(accounting).toContainText('calculation tokens-times-usd-per-million-v1');
		await expect(accounting).toContainText('model identity requested_launch_no_observed_reroute');
		await expect(accounting).toContainText('usage scope attempt');
		await expect(accounting).toContainText('context short');
		await expect(accounting).toContainText('source https://example.test/pricing');
		await expect(accounting).toContainText('checked 2026-09-12');
		await expect(accounting).toContainText('effective 2026-09-01');
		await expect(accounting).toContainText('rates input=100000');
		await expect(accounting).toContainText('per 1000000 tokens');
		await page.goBack();
		await expect(page.getByRole('heading', { name: 'Contributing issues' })).toBeVisible();
		await page.getByRole('button', { name: 'Close detail' }).click();
		await expect(page.getByRole('heading', { name: 'Contributing issues' })).toBeHidden();
	});

	test('shows owner lifetime spend inside Agent activity at phone and desktop widths', async ({
		page
	}) => {
		await armLedgerDays();
		for (const width of [320, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await gotoHydrated(page, `/issues/${encodeURIComponent(SPEND.projects.alpha.name)}/1`);
			if (width === 320) await page.getByRole('button', { name: /Agent activity 1 run/ }).click();
			const total = page.locator('p[title*="retained direct runs"]');
			await expect(total).toHaveText('Total spend: $2.00');
			await expect(total.locator('..').locator('h2')).toContainText('Agent activity');
			expect(await total.evaluate((element) => element.previousElementSibling?.tagName)).toBe('H2');
			await expect(total).toHaveAttribute('title', /As of .*Z\./);
			await expect(page.getByRole('heading', { name: 'Lifetime through now' })).toHaveCount(0);
			await expect(page.getByRole('region', { name: 'Contributing runs' })).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'Refresh through now' })).toHaveCount(0);
			await expect(page.locator('[data-run-id="run_e2e_spend_alpha_today"]')).toBeVisible();
			await expect(page.locator('[data-run-id="run_e2e_spend_alpha_today"]')).toContainText(
				'$2.00'
			);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
			).toBe(true);
		}
	});

	test('resets spend while following an issue link before destination usage settles', async ({
		page,
		request
	}) => {
		await armLedgerDays();
		const api = apiClient(request, SPEND.apiKey);
		const sourceId = 'iss_e2e_spend_alpha_today';
		const destinationId = 'iss_e2e_spend_zero';
		const link = await body<{ id: string }>(
			await api.post(`/api/v1/issues/${sourceId}/links`, {
				kind: 'duplicate_of',
				issue_id: destinationId
			})
		);
		try {
			await gotoHydrated(page, `/issues/${encodeURIComponent(SPEND.projects.alpha.name)}/1`);
			const total = page.locator('p[title*="retained direct runs"]');
			await expect(total).toHaveText('Total spend: $2.00');
			// SvelteKit streams the destination's data in lines. Pass every chunk
			// except the usage promise, so the activity card renders while spend waits.
			await page.evaluate(() => {
				const nativeFetch = window.fetch.bind(window);
				window.fetch = async (...args) => {
					const response = await nativeFetch(...args);
					const input = args[0];
					const url = new URL(
						typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
						location.href
					);
					if (!url.pathname.endsWith('/__data.json') || !response.body) return response;
					const reader = response.body.getReader();
					const encoder = new TextEncoder();
					const decoder = new TextDecoder();
					const stream = new ReadableStream<Uint8Array>({
						async start(controller) {
							let buffer = '';
							let usageId: number | undefined;
							let heldLine = '';
							let sourceDone = false;
							const release = window as typeof window & { releaseSpendStream?: () => void };
							const sendLine = (line: string) => {
								if (usageId === undefined) {
									const payload = JSON.parse(line) as { nodes: { data: unknown[] }[] };
									const data = payload.nodes.at(-1)!.data;
									const root = data[0] as { deferred: number };
									const deferred = data[root.deferred] as { usage: number };
									const promise = data[deferred.usage] as [string, number];
									usageId = data[promise[1]] as number;
									controller.enqueue(encoder.encode(line));
									return;
								}
								const chunk = JSON.parse(line) as { type: string; id?: number };
								if (chunk.type !== 'chunk' || chunk.id !== usageId) {
									controller.enqueue(encoder.encode(line));
									return;
								}
								heldLine = line;
								release.releaseSpendStream = () => {
									if (!heldLine) return;
									controller.enqueue(encoder.encode(heldLine));
									heldLine = '';
									if (sourceDone) controller.close();
								};
							};
							try {
								for (;;) {
									const { done, value } = await reader.read();
									if (done) break;
									buffer += decoder.decode(value, { stream: true });
									let boundary: number;
									while ((boundary = buffer.indexOf('\n')) >= 0) {
										sendLine(buffer.slice(0, boundary + 1));
										buffer = buffer.slice(boundary + 1);
									}
								}
								if (buffer) sendLine(buffer);
								sourceDone = true;
								if (!heldLine) controller.close();
							} catch (error) {
								controller.error(error);
							}
						}
					});
					return new Response(stream, { status: response.status, headers: response.headers });
				};
			});
			await page
				.getByRole('link', { name: `${SPEND.projects.zero.name}/#1` })
				.first()
				.click({ noWaitAfter: true });
			await expect(page.getByRole('heading', { name: 'Spend zero' })).toBeVisible();
			await expect(page.getByText('Total spend: Loading…')).toBeVisible();
			await expect
				.poll(() =>
					page.evaluate(
						() =>
							typeof (window as typeof window & { releaseSpendStream?: () => void })
								.releaseSpendStream
					)
				)
				.toBe('function');
			await page.evaluate(() => {
				(window as typeof window & { releaseSpendStream?: () => void }).releaseSpendStream?.();
			});
			await expect(total).toHaveText('Total spend: $0');
		} finally {
			await page
				.evaluate(() => {
					(window as typeof window & { releaseSpendStream?: () => void }).releaseSpendStream?.();
				})
				.catch(() => {});
			await api.delete(`/api/v1/issues/${sourceId}/links/${link.id}`);
		}
	});

	test('sums all direct runs beyond the latest 20 and refreshes the total', async ({ page }) => {
		await armLedgerDays();
		const issueUrl = `/issues/${encodeURIComponent(SPEND.projects.alpha.name)}/1`;
		try {
			d1(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 20)
				INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, outcome, tier, model, usage, state_id_at_start, state_id_at_end, log, created_at, started_at, ended_at)
				SELECT 'run_e2e_spend_extra_' || x, r.user_id, r.issue_id, r.runner_id, r.status, r.outcome, r.tier, r.model, r.usage, r.state_id_at_start, r.state_id_at_end, r.log, r.created_at + x, r.started_at + x, r.ended_at + x
				FROM agent_run r, n WHERE r.id = 'run_e2e_spend_alpha_today'`);
			await gotoHydrated(page, issueUrl);
			const card = page.getByRole('heading', { name: 'Agent activity' }).locator('..');
			await expect(card.locator('p[title*="retained direct runs"]')).toHaveText(
				'Total spend: $42.00'
			);
			await expect(card.locator('li[data-run-id]')).toHaveCount(20);
			d1(
				`UPDATE agent_run SET usage = json_set(usage, '$.cost_usd', 3) WHERE id = 'run_e2e_spend_extra_1'`
			);
			await page.reload({ waitUntil: 'networkidle' });
			await expect(card.locator('p[title*="retained direct runs"]')).toHaveText(
				'Total spend: $43.00'
			);
		} finally {
			d1(`DELETE FROM agent_run WHERE id LIKE 'run_e2e_spend_extra_%'`);
		}
	});

	test('labels empty, unknown, partial, pending, and measured-zero totals', async ({ page }) => {
		await armLedgerDays();
		armPendingRun();
		const cases = [
			[`${SPEND.projects.alpha.id}/5`, 'No agent runs'],
			[`${SPEND.projects.pending.id}/1`, 'No finalized runs · 1 pending'],
			[`${SPEND.projects.unreported.id}/1`, 'Unknown'],
			[`${SPEND.projects.tokens.id}/1`, 'Unknown'],
			[`${SPEND.projects.zero.id}/1`, '$0']
		] as const;
		for (const [issuePath, expected] of cases) {
			await page.goto(`/issues/${issuePath}`);
			await expect(page.locator('p[title*="retained direct runs"]')).toHaveText(
				`Total spend: ${expected}`
			);
		}
		try {
			d1(`INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, outcome, tier, model, usage, state_id_at_start, log, created_at, started_at, ended_at)
				SELECT 'run_e2e_spend_partial_pending', user_id, 'iss_e2e_spend_alpha_today', runner_id, status, outcome, tier, model, usage, state_id_at_start, log, created_at, started_at, ended_at
				FROM agent_run WHERE id = 'run_e2e_spend_pending'`);
			await page.goto(`/issues/${SPEND.projects.alpha.id}/1`);
			await expect(page.locator('p[title*="retained direct runs"]')).toHaveText(
				'Total spend: $2.00 · 1 pending'
			);
			d1(`INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, outcome, tier, model, usage, state_id_at_start, state_id_at_end, log, created_at, started_at, ended_at)
				SELECT 'run_e2e_spend_partial', user_id, issue_id, runner_id, status, outcome, tier, model, NULL, state_id_at_start, state_id_at_end, log, created_at + 1, started_at + 1, ended_at + 1
				FROM agent_run WHERE id = 'run_e2e_spend_alpha_today'`);
			await page.goto(`/issues/${encodeURIComponent(SPEND.projects.alpha.name)}/1`);
			await expect(page.locator('p[title*="retained direct runs"]')).toHaveText(
				'Total spend: $2.00 · partial · 1 pending'
			);
		} finally {
			d1(
				`DELETE FROM agent_run WHERE id IN ('run_e2e_spend_partial', 'run_e2e_spend_partial_pending')`
			);
		}
	});
});
