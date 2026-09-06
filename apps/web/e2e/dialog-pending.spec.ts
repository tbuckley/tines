import type { IssueDetail, Project, WorkflowResponse } from '@tines/shared';
import { expect, test, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, clickUntil, gotoHydrated, runId, signIn } from './helpers';

// This file exercises the animation itself; the suite default is reduced
// motion (playwright.config.ts). The reduced-motion tests below still call
// page.emulateMedia({ reducedMotion: 'reduce' }) per test, which overrides
// this file-level setting. See e2e/README.md.
test.use({ reducedMotion: 'no-preference' });

/**
 * The confirm button's pending state (Tines/153). Confirming a transition used
 * to swap the button's label for "Moving…", which collapsed its `auto` width
 * in a single frame — in a `justify-end` row that slides Cancel left, onto
 * pixels the dark confirm button had been painted on one frame earlier, which
 * reads as a second button flashing over it. Meanwhile the button's own
 * `transition-all` re-coloured it over the following 150 ms, *after* it had
 * moved. `PendingButton` keeps the label's box and puts a spinner in it.
 *
 * Two more defects measured alongside it and fixed here: a `Modal` mounted
 * inside a caller's `{#if}` tore down with no outro (Svelte transitions are
 * local unless `|global`), and at phone width the action row could not wrap,
 * so a long user-authored transition name pushed Cancel under the dialog's
 * `overflow: hidden`.
 *
 * Named to sort after `artifacts-panel.spec.ts` — see the header of
 * `dialog-animation.spec.ts` for why that matters.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/** Long enough to overflow a 390px dialog's action row beside "Cancel". */
const LONG_TRANSITION = 'Send back to research for another pass';

const projectName = `dialog-pending-${runId}`;
let project: Project;
let workflowId: string;

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({
		baseURL: test.info().project.use.baseURL
	});
	const api = apiClient(request, ALICE.apiKey);
	project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));

	const workflow = await body<WorkflowResponse>(
		await api.post('/api/v1/workflows', {
			name: `Dialog pending ${runId}`,
			initial_state: 'Design',
			states: [
				{ name: 'Design', category: 'active' },
				{ name: 'Research', category: 'active' }
			],
			transitions: [{ name: LONG_TRANSITION, from: 'Design', to: 'Research' }]
		})
	);
	workflowId = workflow.id;
	await request.dispose();
});

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

const stateCard = (page: Page) =>
	page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'State', exact: true }) });

const dialogOf = (page: Page) => page.getByRole('dialog');

/**
 * The confirm button, addressed by `type="submit"` rather than by name: while
 * pending its accessible name is deliberately "Moving…", so a name-based
 * locator would stop resolving exactly where these tests look hardest.
 */
const confirmButton = (page: Page) => dialogOf(page).locator('button[type="submit"]');
const cancelButton = (page: Page) => dialogOf(page).getByRole('button', { name: 'Cancel' });

/**
 * The dialog's entrance animation has finished. Everything below depends on
 * this: `Modal` scales in from 0.96, so a box read mid-intro is ~4% small (and
 * two `evaluate` round-trips inside one frame read the *same* wrong box, which
 * is enough to fool a settle loop). Svelte also reverses an outro from
 * whatever progress the intro reached, so a Cancel clicked at 17% opacity
 * closes in 40ms rather than 150 — a real animation that measures like a hard
 * cut. `getAnimations()` on the dialog itself: no `subtree`, so the spinner's
 * infinite `animate-spin` can never make this unsatisfiable.
 */
async function entranceSettled(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		const dialog = document.querySelector('[role="dialog"]');
		return !!dialog && dialog.getAnimations().every((a) => a.playState === 'finished');
	});
}

/**
 * A fresh issue per test, not one shared fixture: the first test confirms the
 * transition for real, which moves the issue out of `Design` and takes the
 * only transition button with it.
 */
async function openTransitionDialog(page: Page): Promise<void> {
	const api = apiClient(page.request, ALICE.apiKey);
	const issue = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, {
			title: `Dialog pending ${Date.now().toString(36)}`,
			workflow_id: workflowId,
			description: 'Fixture for the confirm-button pending assertions.'
		})
	);
	await gotoHydrated(page, `/issues/${encodeURIComponent(projectName)}/${issue.number}`);
	if (await stateCard(page).isVisible()) {
		await clickUntil(stateCard(page).getByRole('button', { name: LONG_TRANSITION }), async () => {
			await expect(dialogOf(page)).toBeVisible({ timeout: 2_000 });
		});
	} else {
		// A phone: the card is a desktop surface, and a name this long never
		// fits the bar, so it is reached through the State sheet — which the
		// confirm dialog then replaces, leaving one dialog on the page.
		const sheet = page.getByRole('dialog', { name: 'State' });
		await clickUntil(page.getByRole('button', { name: /^State:/ }), async () => {
			await expect(sheet).toBeVisible({ timeout: 2_000 });
		});
		await sheet.getByRole('button', { name: LONG_TRANSITION }).click();
		await expect(sheet).toBeHidden();
		await expect(dialogOf(page)).toBeVisible();
	}
	await entranceSettled(page);
}

type Box = { x: number; y: number; width: number; height: number };
type Footer = { confirm: Box; cancel: Box; row: Box };

/**
 * The confirm button, Cancel and the row holding them as of ONE settled
 * layout. Two `boundingBox()` reads are two moments and the issue page keeps
 * resolving streamed panels after the dialog is up (Tines/123), so every box a
 * comparison needs is read inside a single `evaluate`, repeated until two
 * consecutive reads agree.
 */
async function footerBoxes(page: Page): Promise<Footer> {
	const read = () =>
		page.evaluate(() => {
			const confirm = document.querySelector<HTMLElement>('[role="dialog"] button[type="submit"]');
			if (!confirm) throw new Error('no confirm button');
			const row = confirm.parentElement;
			if (!row) throw new Error('confirm button has no row');
			const cancel = [...row.querySelectorAll('button')].find(
				(b) => b.textContent?.trim() === 'Cancel'
			);
			if (!cancel) throw new Error('no Cancel button in the row');
			const box = (el: Element): Box => {
				const { x, y, width, height } = el.getBoundingClientRect();
				return { x, y, width, height };
			};
			return { confirm: box(confirm), cancel: box(cancel), row: box(row) };
		});

	// A frame between reads, deliberately: rendering is rAF-throttled, so two
	// reads inside one frame return an identical box even mid-animation.
	const nextFrame = () =>
		page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

	let previous = await read();
	for (let attempt = 0; attempt < 20; attempt++) {
		await nextFrame();
		const next = await read();
		if (JSON.stringify(next) === JSON.stringify(previous)) return next;
		previous = next;
	}
	throw new Error('layout never settled');
}

function expectSameBox(actual: Box, expected: Box, what: string): void {
	for (const side of ['x', 'y', 'width', 'height'] as const) {
		expect(Math.abs(actual[side] - expected[side]), `${what}: ${side}`).toBeLessThanOrEqual(0.5);
	}
}

/**
 * Holds every transition request until the returned `release` is called, so
 * the pending state can be measured instead of raced.
 */
async function holdTransition(page: Page): Promise<() => void> {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/api/v1/issues/*/transition', async (route) => {
		await held;
		await route.continue();
	});
	return release;
}

test('the confirm button does not move when it goes pending', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await openTransitionDialog(page);

	const idle = await footerBoxes(page);
	// The whole point: the idle label is far wider than "Moving…", so a naive
	// label swap has room to collapse the button and slide Cancel across it.
	expect(idle.confirm.width).toBeGreaterThan(120);

	const release = await holdTransition(page);
	await confirmButton(page).click();

	await expect(confirmButton(page)).toHaveAttribute('aria-busy', 'true');
	await expect(confirmButton(page).locator('svg.animate-spin')).toBeVisible();
	// The pending text survives for assistive tech even though it is not drawn.
	await expect(confirmButton(page)).toHaveAccessibleName('Moving…');
	await expect(confirmButton(page)).toBeDisabled();
	// Nothing to cancel while the request is in flight.
	await expect(cancelButton(page)).toBeDisabled();

	const pending = await footerBoxes(page);
	expectSameBox(pending.confirm, idle.confirm, 'confirm button');
	expectSameBox(pending.cancel, idle.cancel, 'Cancel button');

	release();
	await expect(dialogOf(page)).toBeHidden();
	await expect(page.locator(`[style*="issue-state"]`)).toContainText('Research');
});

/**
 * `Modal`'s transitions are `|global` so that a caller mounting it inside its
 * own `{#if}` with `open={true}` still plays the outro when that block is
 * destroyed. Without it the dialog is removed in the same flush as the click
 * — detached before the first frame — so this measures how long the element
 * survives rather than merely that it closes.
 */
async function msUntilDetached(page: Page): Promise<number> {
	return page.evaluate(() => {
		const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
		if (!dialog) throw new Error('no dialog');
		const cancel = [...dialog.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'Cancel'
		);
		if (!cancel) throw new Error('no Cancel button');
		const started = performance.now();
		cancel.click();
		return new Promise<number>((resolve) => {
			const tick = () => {
				const elapsed = performance.now() - started;
				if (!dialog.isConnected) resolve(elapsed);
				else if (elapsed > 2_000) resolve(-1);
				else requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
	});
}

/** Clearly inside the 150 ms outro, clearly outside a frame or two of teardown. */
const OUTRO_BOUNDARY_MS = 80;

test('a dialog mounted in an {#if} block animates out when it closes', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await openTransitionDialog(page);

	const elapsed = await msUntilDetached(page);
	expect(elapsed, 'the dialog should outlive the click by its outro').toBeGreaterThan(
		OUTRO_BOUNDARY_MS
	);
	await expect(dialogOf(page)).toBeHidden();
});

// The pair matters: a fast teardown is also what a dialog that never animated
// reports, so the test above only means something alongside this one. The
// in-test `emulateMedia` overrides this file's `test.use` opt-out.
test('a reduced-motion preference closes the dialog without an outro', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await openTransitionDialog(page);

	const elapsed = await msUntilDetached(page);
	expect(elapsed).toBeGreaterThanOrEqual(0);
	expect(elapsed, 'a 0 ms outro should not hold the dialog open').toBeLessThan(OUTRO_BOUNDARY_MS);
	await expect(dialogOf(page)).toBeHidden();
});

test('a long transition name does not push the action row out of the dialog', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await openTransitionDialog(page);

	const idle = await footerBoxes(page);
	for (const [what, box] of [
		['confirm button', idle.confirm],
		['Cancel button', idle.cancel]
	] as const) {
		expect(box.x, `${what} starts inside the row`).toBeGreaterThanOrEqual(idle.row.x - 0.5);
		expect(box.x + box.width, `${what} ends inside the row`).toBeLessThanOrEqual(
			idle.row.x + idle.row.width + 0.5
		);
	}
	await expect(confirmButton(page)).toBeVisible();
	await expect(cancelButton(page)).toBeVisible();

	// The wrapped layout is the one most likely to shift under the swap.
	const release = await holdTransition(page);
	await confirmButton(page).click();
	await expect(confirmButton(page)).toHaveAttribute('aria-busy', 'true');

	const pending = await footerBoxes(page);
	expectSameBox(pending.confirm, idle.confirm, 'confirm button');
	expectSameBox(pending.cancel, idle.cancel, 'Cancel button');

	release();
	await expect(dialogOf(page)).toBeHidden();
});
