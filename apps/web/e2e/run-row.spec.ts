/**
 * Run rows and routing-rule rows render from one component each, so the
 * surfaces that list them cannot drift apart again.
 *
 * Both rows used to exist as two hand-maintained copies — one inline in the
 * Agents page, one in the shared card used on the issue / project / workflow
 * pages — and in both cases a feature commit updated only the Agents page:
 * the issue page lost cost and the provider console link, and the project /
 * workflow pages lost the "never dispatches" badge. Each test below asserts
 * the same row content on *both* surfaces, so a future one-sided edit fails
 * here rather than shipping.
 */
import type { Workflow } from '@tines/shared';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE, RUNROW, RUNROW_ESTIMATED, RUNROW_FAILED } from './constants.mjs';
import { apiClient, body, gotoHydrated, resetFocus, signIn } from './helpers';

test.describe('shared run row', () => {
	test.use({ signedIn: ALICE });

	test.beforeEach(async ({ request }) => {
		// Specs share one user: a focus left behind would scope this one's lists.
		await resetFocus(request);
	});

	test('shows cost and the provider console link on the issue page and the Agents tab', async ({
		page
	}) => {
		// The issue page: the natural place to watch a managed run, and the
		// surface that used to show neither field.
		await page.goto(`/issues/${encodeURIComponent(RUNROW.projectName)}/${RUNROW.issueNumber}`);

		// li:not([inert]): rows in animated lists are marked inert by Svelte 5's
		// out() while they are still siblings inside the live <ul>, so an
		// unscoped li can match a row on its way out (Tines/154, e2e/README.md).
		const issueRow = page.locator('li:not([inert])', { hasText: RUNROW.runnerName });
		await expect(issueRow).toHaveCount(1);
		await expect(issueRow).toContainText(RUNROW.costLabel);
		await expect(issueRow).toContainText(`session: ${RUNROW.providerSessionId}`);
		// How the end was judged, beside the status: the difference between a
		// run that cost the issue a strike and one that cost it nothing.
		await expect(issueRow).toContainText(RUNROW.outcome);
		await expect(issueRow.getByRole('link', { name: /console/ })).toHaveAttribute(
			'href',
			RUNROW.providerUrl
		);

		// The Agents tab hides ended runs behind a toggle, and the fixture is
		// deliberately `completed` (a live run would be swept and flake).
		await gotoHydrated(page, '/agents');
		await page.getByLabel('Show ended runs').check();

		// li:not([inert]): rows in animated lists are marked inert by Svelte 5's
		// out() while they are still siblings inside the live <ul>, so an
		// unscoped li can match a row on its way out (Tines/154, e2e/README.md).
		const agentsRow = page.locator('li:not([inert])', { hasText: RUNROW.runnerName });
		await expect(agentsRow).toHaveCount(1);
		await expect(agentsRow).toContainText(RUNROW.costLabel);
		await expect(agentsRow).toContainText(`session: ${RUNROW.providerSessionId}`);
		await expect(agentsRow).toContainText(RUNROW.outcome);
		await expect(agentsRow.getByRole('link', { name: /console/ })).toHaveAttribute(
			'href',
			RUNROW.providerUrl
		);
		const runnerCard = page.locator('div.rounded-lg', { hasText: RUNROW.runnerName }).first();
		await expect(runnerCard).toContainText('1 consecutive failure');
		await expect(runnerCard).not.toContainText('1 consecutive failures');
	});

	test('distinguishes an empty ended log from a live wait', async ({ page, request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const detail = await body<Record<string, unknown>>(
			await api.get(`/api/v1/runs/${RUNROW.runId}`)
		);
		await page.route(`**/api/v1/runs/${RUNROW.runId}`, (route) =>
			route.fulfill({ json: { ...detail, log: '' } })
		);
		await gotoHydrated(
			page,
			`/issues/${encodeURIComponent(RUNROW.projectName)}/${RUNROW.issueNumber}`
		);
		const row = page.locator('li:not([inert])', { hasText: RUNROW.runnerName });
		await row.getByRole('button', { name: 'Logs' }).click();
		await expect(row.getByTestId('run-log')).toHaveText('(no log output captured)');
		await expect(row.getByTestId('run-log-waiting')).toHaveCount(0);
	});

	test('shows unpriced Codex tokens and a local thread id', async ({ page }) => {
		await page.goto(`/issues/${encodeURIComponent(RUNROW.projectName)}/${RUNROW.issueNumber}`);
		const row = page.locator('li:not([inert])', { hasText: RUNROW_FAILED.runnerName });
		await expect(row).toContainText(RUNROW_FAILED.tokenLabel);
		await expect(row).toContainText(`session: ${RUNROW_FAILED.providerSessionId}`);
		await expect(row).toContainText(`resumed run ${RUNROW_FAILED.resumedFromRunId}`);
		await expect(row.getByRole('link', { name: /resumed run/ })).toHaveCount(0);
	});

	test('discloses persisted estimate evidence and restores focus without closing logs', async ({
		page
	}) => {
		await gotoHydrated(
			page,
			`/issues/${encodeURIComponent(RUNROW.projectName)}/${RUNROW_ESTIMATED.issueNumber}`
		);
		const row = page.locator('li:not([inert])', { hasText: RUNROW_ESTIMATED.runnerName });
		const estimate = row.getByRole('button', { name: /Estimated/ });
		await expect(estimate).toHaveText('<$0.01 Estimated');
		await row.getByRole('button', { name: 'Logs' }).click();
		await estimate.click();
		const dialog = page.getByRole('dialog', { name: 'Cost evidence' });
		await expect(dialog).toContainText('gpt-5.6-sol');
		await expect(dialog).toContainText('0.00394');
		await expect(dialog).toContainText('not an invoice or subscription usage');
		await expect(dialog.getByRole('link', { name: /Official pricing source/ })).toHaveAttribute(
			'href',
			'https://developers.openai.com/api/docs/pricing'
		);
		await page.keyboard.press('Escape');
		await expect(estimate).toBeFocused();
		await expect(row.getByRole('button', { name: 'Hide logs' })).toBeVisible();
	});

	test('keeps the cost-evidence heading visible inside a phone fold', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await gotoHydrated(
			page,
			`/issues/${encodeURIComponent(RUNROW.projectName)}/${RUNROW_ESTIMATED.issueNumber}`
		);
		await page.getByRole('button', { name: /^Agent activity/ }).click();
		const row = page.locator('li:not([inert])', { hasText: RUNROW_ESTIMATED.runnerName });
		await row.getByRole('button', { name: /Estimated/ }).click();
		const dialog = page.getByRole('dialog', { name: 'Cost evidence' });
		await expect(dialog.getByRole('heading', { name: 'Cost evidence', level: 2 })).toBeVisible();
	});
});

test.describe('shared routing-rule row', () => {
	let STATE_NAME: string;

	let workflowId: string;
	let stateId: string;

	test.beforeAll(async ({ request, uniqueName }) => {
		STATE_NAME = uniqueName('Dead', { maxLength: 100 });
		const fixtureName = uniqueName('rulerow');
		const api = apiClient(request, ALICE.apiKey);
		/** Fixture setup must not fail silently — a 422 here would look like a UI bug. */
		const ok = async (res: Awaited<ReturnType<typeof api.post>>, what: string) => {
			if (!res.ok()) throw new Error(`${what} failed: ${res.status()} ${await res.text()}`);
			return res;
		};

		// A paused runner: this rule must never actually dispatch anything.
		const runner = await body<{ id: string }>(
			await ok(
				await api.post('/api/v1/runners', { type: 'local', name: fixtureName }),
				'create runner'
			)
		);
		await ok(await api.patch(`/api/v1/runners/${runner.id}`, { status: 'paused' }), 'pause runner');

		// A custom workflow — the standard one is read-only, so its state
		// categories cannot be edited.
		const workflow = await body<Workflow>(
			await ok(
				await api.post('/api/v1/workflows', {
					name: fixtureName,
					initial_state: STATE_NAME,
					states: [
						{ name: STATE_NAME, category: 'active' },
						{ name: 'Done', category: 'done' }
					],
					transitions: [{ name: 'finish', from: STATE_NAME, to: 'Done' }]
				}),
				'create workflow'
			)
		);
		workflowId = workflow.id;
		stateId = workflow.states.find((s) => s.name === STATE_NAME)!.id;
		const doneId = workflow.states.find((s) => s.name === 'Done')!.id;

		// Order matters: the rule must be created while the state is still
		// active, because the server rejects a non-active rule scope outright.
		await ok(
			await api.post('/api/v1/routing-rules', {
				workflow_state_id: stateId,
				targets: [{ runner_id: runner.id }]
			}),
			'create rule'
		);

		// Now recategorize the state out of `active` — the rule is dead.
		await ok(
			await api.patch(`/api/v1/workflows/${workflowId}`, {
				states: [
					{ id: stateId, name: STATE_NAME, category: 'backlog' },
					{ id: doneId, name: 'Done', category: 'done' }
				]
			}),
			'recategorize state'
		);
	});

	test.use({ signedIn: ALICE });

	test.beforeEach(async ({ request }) => {
		// Specs share one user: a focus left behind would scope this one's lists.
		await resetFocus(request);
	});

	/** The rule row for this suite's state, carrying the dead-rule badge. */
	const deadRuleRow = (page: Page) =>
		page.locator('li').filter({ hasText: STATE_NAME }).filter({ hasText: 'never dispatches' });

	test('flags a rule scoped out of active on the workflow page and the Agents tab', async ({
		page
	}) => {
		// The workflow page is exactly where a recategorized state is looked
		// at, and where the dead rule used to render as if it worked.
		await page.goto(`/workflows/${workflowId}`);
		await expect(deadRuleRow(page)).toHaveCount(1);

		await page.goto('/agents');
		await expect(deadRuleRow(page)).toHaveCount(1);
	});
});

/**
 * A failed run's error is the most useful line on its row, and it used to be
 * cut to one ellipsised line ("…ENOSPC: no space left on…") with the rest
 * reachable only by opening Logs and scrolling to the end. The row now clamps
 * to two lines and the Logs disclosure leads with the whole string.
 */
test.describe('failed run error', () => {
	const FULL = RUNROW_FAILED.error;

	test.use({ signedIn: ALICE });

	test.beforeEach(async ({ request }) => {
		// Specs share one user: a focus left behind would scope this one's lists.
		await resetFocus(request);
	});

	/** The seeded failed run's row, on whichever surface is loaded. */
	const failedRow = (page: Page) =>
		page
			.locator('li:not([inert])', { hasText: RUNROW_FAILED.runnerName })
			.filter({ has: page.getByTestId('run-error') });

	test('clamps the error to two lines, not one, on the issue page and the Agents tab', async ({
		page
	}) => {
		for (const surface of ['issue', 'agents'] as const) {
			if (surface === 'issue') {
				await page.goto(`/issues/${encodeURIComponent(RUNROW.projectName)}/${RUNROW.issueNumber}`);
			} else {
				await gotoHydrated(page, '/agents');
				await page.getByLabel('Show ended runs').check();
			}

			const row = failedRow(page);
			await expect(row).toHaveCount(1);

			const error = row.getByTestId('run-error');
			// The whole reason stays available on hover, at every width.
			await expect(error).toHaveAttribute('title', FULL);

			// Read every number the assertion compares inside one layout pass:
			// the run rows keep settling as the log-tail fetches resolve.
			const box = await error.evaluate((el) => {
				const style = getComputedStyle(el);
				return {
					clamp: style.webkitLineClamp,
					lineHeight: parseFloat(style.lineHeight),
					clientHeight: el.clientHeight,
					scrollHeight: el.scrollHeight
				};
			});

			// Fixture sanity: this error is longer than the two lines shown, so
			// the height below is a clamp and not just a string that fits.
			expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
			expect(box.clamp).toBe('2');
			// Two lines rendered, where `truncate` gave exactly one.
			expect(box.clientHeight).toBeGreaterThan(box.lineHeight * 1.5);
		}
	});

	test('leads the Logs disclosure with the untruncated error', async ({ page }) => {
		await gotoHydrated(
			page,
			`/issues/${encodeURIComponent(RUNROW.projectName)}/${RUNROW.issueNumber}`
		);

		const row = failedRow(page);
		await row.getByRole('button', { name: 'Logs' }).click();

		// Whole, and readable without hovering or scrolling a log to its end.
		const full = row.getByTestId('run-error-full');
		await expect(full).toHaveText(FULL);

		// First line of the disclosure: ahead of the log tail, not below it.
		// `Node.DOCUMENT_POSITION_FOLLOWING` (4) only exists in the page.
		const precedesLog = await full.evaluate(
			(el, pre) => Boolean(el.compareDocumentPosition(pre!) & Node.DOCUMENT_POSITION_FOLLOWING),
			await row.getByTestId('run-log').elementHandle()
		);
		expect(precedesLog).toBe(true);
	});
});
