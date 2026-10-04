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
import { ALICE, RUNROW, RUNROW_ESTIMATED, RUNROW_FAILED, RUNROW_STALLED } from './constants.mjs';
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
		// The session id and the effort disclosure are `tines runs show`'s, not
		// the row's: neither helps a person scanning runs (Tines/920).
		await expect(issueRow).not.toContainText(RUNROW.providerSessionId);
		await expect(issueRow).not.toContainText('Effort details');
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
		await expect(agentsRow).not.toContainText(RUNROW.providerSessionId);
		await expect(agentsRow).not.toContainText('Effort details');
		await expect(agentsRow).toContainText(RUNROW.outcome);
		await expect(agentsRow.getByRole('link', { name: /console/ })).toHaveAttribute(
			'href',
			RUNROW.providerUrl
		);
		const runnerCard = page.locator('div.rounded-lg', { hasText: RUNROW.runnerName }).first();
		await expect(runnerCard).toContainText('1 consecutive failure');
		await expect(runnerCard).not.toContainText('1 consecutive failures');
	});

	test('leads ended runs with the Activity feed outcome glyph and color on both surfaces', async ({
		page
	}) => {
		const expected = [
			{ runner: RUNROW.runnerName, icon: /tabler-icon-circle-check/, color: /text-emerald-600/ },
			{ runner: RUNROW_FAILED.runnerName, icon: /tabler-icon-circle-x/, color: /text-destructive/ },
			{
				runner: RUNROW_STALLED.runnerName,
				icon: /tabler-icon-alert-triangle/,
				color: /text-amber-700/
			}
		];
		for (const surface of ['issue', 'agents'] as const) {
			if (surface === 'issue') {
				await gotoHydrated(
					page,
					`/issues/${encodeURIComponent(RUNROW.projectName)}/${RUNROW.issueNumber}`
				);
			} else {
				await gotoHydrated(page, '/agents');
				await page.getByLabel('Show ended runs').check();
			}
			for (const { runner, icon, color } of expected) {
				const row = page.locator('li:not([inert])', { hasText: runner });
				const glyph = row.getByTestId('run-outcome-icon');
				await expect(glyph, `${surface}: ${runner}`).toHaveClass(color);
				await expect(glyph.locator('svg'), `${surface}: ${runner}`).toHaveClass(icon);
				await expect(row.getByTestId('run-status'), `${surface}: ${runner}`).toHaveClass(color);
				await expect(row.getByTestId('run-live-dot')).toHaveCount(0);
			}
			await expect(
				page
					.locator('li:not([inert])', { hasText: RUNROW_FAILED.runnerName })
					.getByTestId('run-error')
			).toHaveClass(/text-destructive/);
		}
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

	test('shows model, bare effort and tier in their own cells, and the rest in a tooltip, on both surfaces', async ({
		page
	}) => {
		for (const surface of ['issue', 'agents'] as const) {
			if (surface === 'issue') {
				await page.goto(`/issues/${encodeURIComponent(RUNROW.projectName)}/${RUNROW.issueNumber}`);
			} else {
				await gotoHydrated(page, '/agents');
				await page.getByLabel('Show ended runs').check();
			}
			const row = page.locator('li:not([inert])', { hasText: RUNROW.runnerName });
			await expect(row.getByTestId('run-model'), surface).toHaveText('claude-opus-4');
			await expect(row.getByTestId('run-tier'), surface).toHaveText('balanced');
			// Just "high": where the value came from and whether the provider
			// confirmed it are a hover away, not three more lines.
			const effort = row.getByTestId('run-effort');
			await expect(effort, surface).toHaveText('high');
			await expect(effort, surface).toHaveAttribute('title', /Tier balanced/);
			await expect(effort, surface).toHaveAttribute(
				'title',
				/effort high from runner tier balanced/
			);
			await expect(effort, surface).toHaveAttribute('title', /accepted unconfirmed/);
			await expect(row, surface).not.toContainText('accepted unconfirmed');
			await expect(row, surface).not.toContainText('effort high');

			// No model and no effort recorded: the cells stay in place, empty, so
			// the tier still sits under every other row's tier. No filler text.
			const failed = page.locator('li:not([inert])', { hasText: RUNROW_FAILED.runnerName });
			await expect(failed.getByTestId('run-model'), surface).toHaveText('—');
			await expect(failed.getByTestId('run-effort'), surface).toHaveText('');
			await expect(failed.getByTestId('run-tier'), surface).toHaveText('balanced');
			await expect(failed, surface).not.toContainText('effort unknown');
			await expect(failed, surface).not.toContainText('provider default');
		}
	});

	test('keeps status with its outcome, and the time with Logs at the right, on a phone', async ({
		page
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await gotoHydrated(
			page,
			`/issues/${encodeURIComponent(RUNROW.projectName)}/${RUNROW.issueNumber}`
		);
		await page.getByRole('button', { name: /^Agent activity/ }).click();
		const row = page.locator('li:not([inert])', { hasText: RUNROW_FAILED.runnerName });
		const trailing = row.getByTestId('run-trailing');
		const logs = trailing.getByRole('button', { name: 'Logs' });
		await expect(logs).toBeVisible();

		// "failed · stalled" is one unit: the outcome never wraps alone.
		const result = row.getByTestId('run-status').locator('xpath=..');
		await expect(result).toHaveText(/^failed\s+·\s+stalled$/);
		expect(await result.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap');

		// Read every box inside one layout pass: rows keep settling as the
		// log-tail fetches resolve.
		const boxes = await row.evaluate((li) => {
			const rect = (el: Element) => {
				const r = el.getBoundingClientRect();
				return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
			};
			const group = li.querySelector('[data-testid="run-trailing"]')!;
			return {
				row: rect(li),
				paddingRight: parseFloat(getComputedStyle(li).paddingRight),
				group: rect(group),
				time: rect(li.querySelector('[data-testid="run-time"]')!),
				logs: rect(group.querySelector('button')!)
			};
		});
		// Same line: the time's vertical centre falls inside the button's box.
		const timeCentre = (boxes.time.top + boxes.time.bottom) / 2;
		expect(timeCentre).toBeGreaterThan(boxes.logs.top);
		expect(timeCentre).toBeLessThan(boxes.logs.bottom);
		expect(boxes.time.right).toBeLessThanOrEqual(boxes.logs.left);
		// Right-aligned as a group, where Logs alone used to wrap to the left edge.
		expect(Math.abs(boxes.row.right - boxes.paddingRight - boxes.group.right)).toBeLessThanOrEqual(
			2
		);
	});

	/**
	 * Tines/920: a row used to be one wrapping line, so each fact landed
	 * wherever the ones before it ended and no two rows lined up. Every fact
	 * now has a fixed cell. Each row is its own grid, so this only holds while
	 * the tracks are fixed widths — the edges below are compared across rows
	 * with different runner names, models, statuses and costs.
	 */
	const cellEdges = (page: Page) =>
		page.locator('li[data-run-id]:not([inert])').evaluateAll((rows) =>
			rows.map((li) => {
				const edge = (id: string) => {
					const r = li.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
					return {
						left: Math.round(r.left),
						right: Math.round(r.right),
						mid: (r.top + r.bottom) / 2
					};
				};
				// The label inside the cost cell, not the cell: the cell fills its
				// grid area whichever way the label is aligned within it.
				const costLabel = li.querySelector('[data-testid="run-cost"] > :is(button, span)');
				const costRect = costLabel?.getBoundingClientRect();
				return {
					costLabel: costRect
						? { left: Math.round(costRect.left), right: Math.round(costRect.right) }
						: null,
					runner: edge('run-runner'),
					model: edge('run-model'),
					effort: edge('run-effort'),
					tier: edge('run-tier'),
					status: edge('run-status'),
					duration: edge('run-duration'),
					cost: edge('run-cost'),
					time: edge('run-time'),
					actions: edge('run-trailing')
				};
			})
		);
	type Edges = Awaited<ReturnType<typeof cellEdges>>;
	/** The distinct positions one cell takes across every row; aligned means one. */
	const positions = (
		rows: Edges,
		cell: Exclude<keyof Edges[number], 'costLabel'>,
		side: 'left' | 'right'
	) => [...new Set(rows.map((r) => r[cell][side]))];

	test('puts each fact in the same column on every row of the Agents tab', async ({ page }) => {
		await gotoHydrated(page, '/agents');
		await page.getByLabel('Show ended runs').check();
		await expect(
			page.locator('li:not([inert])', { hasText: RUNROW_STALLED.runnerName })
		).toHaveCount(1);
		const rows = await cellEdges(page);
		expect(rows.length).toBeGreaterThanOrEqual(3);
		for (const cell of [
			'runner',
			'model',
			'effort',
			'tier',
			'status',
			'duration',
			'cost',
			'time'
		] as const) {
			expect(positions(rows, cell, 'left'), `${cell} starts at one x`).toHaveLength(1);
		}
		expect(positions(rows, 'actions', 'right'), 'actions end at one x').toHaveLength(1);
		// One line: the last column sits level with the first.
		for (const r of rows) expect(Math.abs(r.runner.mid - r.time.mid)).toBeLessThan(8);
		// Columns in reading order, none overlapping the next.
		const first = rows[0];
		expect(first.runner.left).toBeLessThan(first.model.left);
		expect(first.model.right).toBeLessThanOrEqual(first.effort.left);
		expect(first.effort.right).toBeLessThanOrEqual(first.tier.left);
		expect(first.tier.right).toBeLessThanOrEqual(first.status.left);
		expect(first.duration.right).toBeLessThanOrEqual(first.cost.left);
		expect(first.cost.right).toBeLessThanOrEqual(first.time.left);
	});

	test('keeps the same three fixed lines on every row of an issue sidebar', async ({ page }) => {
		await gotoHydrated(
			page,
			`/issues/${encodeURIComponent(RUNROW.projectName)}/${RUNROW.issueNumber}`
		);
		await expect(
			page.locator('li:not([inert])', { hasText: RUNROW_STALLED.runnerName })
		).toHaveCount(1);
		const rows = await cellEdges(page);
		expect(rows.length).toBeGreaterThanOrEqual(3);
		// Words start at one x, numbers end at one x.
		for (const cell of ['runner', 'status', 'model', 'effort', 'tier'] as const) {
			expect(positions(rows, cell, 'left'), `${cell} starts at one x`).toHaveLength(1);
		}
		expect(positions(rows, 'actions', 'right'), 'actions end at one x').toHaveLength(1);
		// Fixture sanity: the labels compared differ in width ("$1.23" beside
		// "1,100 tok", "2:00" beside "12:34"), so ending at one x is alignment
		// and not equal strings.
		const priced = rows.flatMap((r) => (r.costLabel ? [r.costLabel] : []));
		expect(new Set(priced.map((c) => c.right - c.left)).size).toBeGreaterThan(1);
		expect(new Set(rows.map((r) => r.duration.right - r.duration.left)).size).toBeGreaterThan(1);
		await expect(
			page
				.locator('li:not([inert])', { hasText: RUNROW_STALLED.runnerName })
				.getByTestId('run-duration')
		).toHaveText(RUNROW_STALLED.durationLabel);
		// One assertion for both, so a row that breaks either names which.
		expect(
			{
				cost: [...new Set(priced.map((c) => c.right))].length,
				duration: positions(rows, 'duration', 'right').length
			},
			'the cost and duration labels each end at one x'
		).toEqual({ cost: 1, duration: 1 });
		for (const r of rows) {
			// Line 1: who and when. Line 2: how it ended and what it cost.
			// Line 3: what it ran on and for how long.
			expect(Math.abs(r.runner.mid - r.time.mid)).toBeLessThan(8);
			expect(r.status.mid).toBeGreaterThan(r.runner.mid + 8);
			expect(Math.abs(r.status.mid - r.cost.mid)).toBeLessThan(8);
			expect(r.model.mid).toBeGreaterThan(r.status.mid + 8);
			for (const cell of ['effort', 'tier', 'duration'] as const) {
				expect(Math.abs(r.model.mid - r[cell].mid)).toBeLessThan(8);
			}
		}
	});

	/**
	 * The Agents tab below the one-line width (a phone, a 1024px window) leads
	 * each row with the issue ref. The runner used to share that line, so it
	 * started wherever the ref ended and, on a phone, an active run with
	 * Logs and Cancel left it no room at all. The ref now has the first line
	 * and the runner starts the second.
	 */
	test('starts the runner at one x under issue refs of different lengths on a narrow Agents tab', async ({
		page
	}) => {
		for (const viewport of [
			{ width: 390, height: 844 },
			{ width: 1024, height: 768 }
		]) {
			const at = `${viewport.width}px`;
			await page.setViewportSize(viewport);
			await gotoHydrated(page, '/agents');
			await page.getByLabel('Show ended runs').check();
			await expect(
				page.locator('li:not([inert])', { hasText: RUNROW_STALLED.runnerName })
			).toHaveCount(1);
			const rows = await page.locator('li[data-run-id]:not([inert])').evaluateAll((lis) =>
				lis.map((li) => {
					const cell = (id: string) => li.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
					const runner = cell('run-runner');
					const actions = cell('run-trailing');
					const box = li.getBoundingClientRect();
					return {
						id: li.getAttribute('data-run-id'),
						ref: cell('run-ref').textContent!.trim(),
						runnerLeft: Math.round(runner.getBoundingClientRect().left),
						runnerWidth: runner.clientWidth,
						runnerClipped: runner.scrollWidth > runner.clientWidth,
						actionsRight: actions.getBoundingClientRect().right,
						contentRight: box.right - parseFloat(getComputedStyle(li).paddingRight),
						consoleLink: actions.querySelector('a') !== null,
						cancel: [...actions.querySelectorAll('button')].some(
							(b) => b.textContent!.trim() === 'Cancel'
						)
					};
				})
			);
			// Fixture sanity: refs of different lengths, or one x proves nothing.
			expect(new Set(rows.map((r) => r.ref.length)).size, at).toBeGreaterThan(1);
			expect(
				[...new Set(rows.map((r) => r.runnerLeft))],
				`${at}: runner starts at one x`
			).toHaveLength(1);

			// The fullest row: an active run with the console link, Logs and
			// Cancel, under the longest ref.
			const active = rows.find((r) => r.id === RUNROW.runKeyRunId)!;
			expect(active, at).toMatchObject({
				ref: `${RUNROW.projectName}/#${RUNROW.runKeyIssueNumber}`,
				consoleLink: true,
				cancel: true
			});
			expect(active.runnerWidth, `${at}: active run's runner is visible`).toBeGreaterThan(0);
			expect(active.runnerClipped, `${at}: active run's runner is shown in full`).toBe(false);
			expect(active.actionsRight, `${at}: actions stay inside the row`).toBeLessThanOrEqual(
				active.contentRight + 1
			);
			const ended = rows.find((r) => r.id === RUNROW.runId)!;
			expect(ended.runnerWidth, `${at}: ended run's runner is visible`).toBeGreaterThan(0);
			expect(ended.runnerClipped, `${at}: ended run's runner is shown in full`).toBe(false);
		}
	});

	test('shows unpriced Codex tokens and resume lineage, not the thread id', async ({ page }) => {
		await page.goto(`/issues/${encodeURIComponent(RUNROW.projectName)}/${RUNROW.issueNumber}`);
		const row = page.locator('li:not([inert])', { hasText: RUNROW_FAILED.runnerName });
		await expect(row).toContainText(RUNROW_FAILED.tokenLabel);
		await expect(row).not.toContainText(RUNROW_FAILED.providerSessionId);
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
	let runnerId: string;
	let ruleId: string;

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
		runnerId = runner.id;
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
		const rule = await body<{ id: string }>(
			await ok(
				await api.post('/api/v1/routing-rules', {
					workflow_state_id: stateId,
					targets: [{ runner_id: runner.id }]
				}),
				'create rule'
			)
		);
		ruleId = rule.id;

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

	test.afterAll(async ({ apiFor }) => {
		const api = apiFor(ALICE);
		if (ruleId) expect((await api.delete(`/api/v1/routing-rules/${ruleId}`)).status()).toBe(204);
		if (workflowId)
			expect((await api.delete(`/api/v1/workflows/${workflowId}`)).status()).toBe(204);
		if (runnerId) expect((await api.delete(`/api/v1/runners/${runnerId}`)).status()).toBe(204);
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
		// A failed run's error reads red here too, matching its ⊗ glyph.
		await expect(full).toHaveClass(/text-destructive/);

		// First line of the disclosure: ahead of the log tail, not below it.
		// `Node.DOCUMENT_POSITION_FOLLOWING` (4) only exists in the page.
		const precedesLog = await full.evaluate(
			(el, pre) => Boolean(el.compareDocumentPosition(pre!) & Node.DOCUMENT_POSITION_FOLLOWING),
			await row.getByTestId('run-log').elementHandle()
		);
		expect(precedesLog).toBe(true);
	});
});
