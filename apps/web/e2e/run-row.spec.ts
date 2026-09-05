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
import { expect, test, type Page } from '@playwright/test';
import { ALICE, RUNROW, RUNROW_FAILED } from './constants.mjs';
import { apiClient, body, gotoHydrated, runId, signIn } from './helpers';

test.describe('shared run row', () => {
	test.beforeEach(async ({ context }) => {
		await signIn(context, ALICE.sessionToken);
	});

	test('shows cost and the provider console link on the issue page and the Agents tab', async ({
		page
	}) => {
		// The issue page: the natural place to watch a managed run, and the
		// surface that used to show neither field.
		await page.goto(`/issues/${encodeURIComponent(RUNROW.projectName)}/${RUNROW.issueNumber}`);

		const issueRow = page.locator('li', { hasText: RUNROW.runnerName });
		await expect(issueRow).toHaveCount(1);
		await expect(issueRow).toContainText(RUNROW.costLabel);
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

		const agentsRow = page.locator('li', { hasText: RUNROW.runnerName });
		await expect(agentsRow).toHaveCount(1);
		await expect(agentsRow).toContainText(RUNROW.costLabel);
		await expect(agentsRow).toContainText(RUNROW.outcome);
		await expect(agentsRow.getByRole('link', { name: /console/ })).toHaveAttribute(
			'href',
			RUNROW.providerUrl
		);
	});
});

test.describe('shared routing-rule row', () => {
	const STATE_NAME = `Dead ${runId}`;

	let workflowId: string;
	let stateId: string;

	test.beforeAll(async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		/** Fixture setup must not fail silently — a 422 here would look like a UI bug. */
		const ok = async (res: Awaited<ReturnType<typeof api.post>>, what: string) => {
			if (!res.ok()) throw new Error(`${what} failed: ${res.status()} ${await res.text()}`);
			return res;
		};

		// A paused runner: this rule must never actually dispatch anything.
		const runner = await body<{ id: string }>(
			await ok(
				await api.post('/api/v1/runners', { type: 'local', name: `rulerow-${runId}` }),
				'create runner'
			)
		);
		await ok(await api.patch(`/api/v1/runners/${runner.id}`, { status: 'paused' }), 'pause runner');

		// A custom workflow — the standard one is read-only, so its state
		// categories cannot be edited.
		const workflow = await body<Workflow>(
			await ok(
				await api.post('/api/v1/workflows', {
					name: `rulerow-${runId}`,
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

	test.beforeEach(async ({ context }) => {
		await signIn(context, ALICE.sessionToken);
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

	test.beforeEach(async ({ context }) => {
		await signIn(context, ALICE.sessionToken);
	});

	/** The seeded failed run's row, on whichever surface is loaded. */
	const failedRow = (page: Page) =>
		page.locator('li').filter({ has: page.getByTestId('run-error') });

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
