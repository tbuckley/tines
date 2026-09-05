import type { IssueDetail, Project, WorkflowResponse } from '@tines/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, readSettled, runId, signIn } from './helpers';

/**
 * The State card's transition stack (Tines/128): buttons used to be a
 * `flex-wrap` row of shrink-to-fit widths — a ragged right edge, and the two
 * longest Engineering labels overflowed the 22rem column outright — while the
 * reason each blocked button was dead sat in one detached list below all of
 * them, so a user had to name-match a button against a paragraph. Now every
 * button is full width with its target right-aligned, each requirement line
 * sits directly under its own button, and enabled transitions sort first. On a
 * phone the whole card moves above the description.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/** Long enough to be clipped by the 22rem column, inside the 100-char cap. */
const LONG_TRANSITION = 'Ask for clarification about this unusually long transition name';
const DESIGN_DOC_DESCRIPTION =
	'The design document for this issue: scope, the change itself, and how it will be tested before review.';

const projectName = `state-card-${runId}`;
let project: Project;
/** In Design with nothing attached: one enabled pair, two blocked. */
let blocked: IssueDetail;
/** In Design with `design-doc` attached: the satisfied check line. */
let fresh: IssueDetail;
/** In Implementation with a `design-doc` predating the move: the stale line. */
let stale: IssueDetail;
/** In Design like `blocked`, but with a description far taller than the card. */
let tall: IssueDetail;

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({
		baseURL: test.info().project.use.baseURL
	});
	const api = apiClient(request, ALICE.apiKey);
	project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));

	// Transition order here is the workflow's own: a blocked one first, so
	// "enabled first" is observable rather than incidental.
	const workflow = await body<WorkflowResponse>(
		await api.post('/api/v1/workflows', {
			name: `State card ${runId}`,
			initial_state: 'Design',
			states: [
				{ name: 'Design', category: 'active' },
				{ name: 'Implementation', category: 'active' },
				{ name: 'Research', category: 'active' },
				{ name: 'Needs Clarification', category: 'awaiting_human' },
				{ name: 'Done', category: 'done' },
				{ name: 'Canceled', category: 'done' }
			],
			transitions: [
				{
					name: 'Design complete',
					from: 'Design',
					to: 'Implementation',
					requires: [{ artifact: 'design-doc', type: 'text', description: DESIGN_DOC_DESCRIPTION }]
				},
				{ name: 'Needs more research', from: 'Design', to: 'Research' },
				{
					name: LONG_TRANSITION,
					from: 'Design',
					to: 'Needs Clarification',
					requires: [{ artifact: 'clarification-request', type: 'text' }]
				},
				{ name: 'Cancel', from: 'Design', to: 'Canceled' },
				{
					name: 'ship',
					from: 'Implementation',
					to: 'Done',
					requires: [{ artifact: 'design-doc', type: 'text' }]
				}
			]
		})
	);

	const newIssue = async (title: string, description = '') =>
		body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title,
				workflow_id: workflow.id,
				description
			})
		);
	const attachDesignDoc = (issueId: string) =>
		api.put(`/api/v1/issues/${issueId}/artifacts/design-doc`, {
			type: 'text',
			content: '# Design\n\nThe shape of the change.\n'
		});

	blocked = await newIssue(`Blocked ${runId}`);
	// A perfectly ordinary long issue: the main column must out-measure the
	// aside, or the stretch this fixture exists to catch cannot happen.
	tall = await newIssue(
		`Tall ${runId}`,
		Array.from(
			{ length: 40 },
			(_, i) =>
				`Paragraph ${i + 1}. The State card sits in the right column of a two-column grid whose left column spans both rows, which is exactly the arrangement that used to stretch it.`
		).join('\n\n')
	);
	fresh = await newIssue(`Fresh ${runId}`);
	await attachDesignDoc(fresh.id);

	// Attach, then move: the version now predates state_entered_at, which is
	// exactly what `ship` reports as stale.
	stale = await newIssue(`Stale ${runId}`);
	await attachDesignDoc(stale.id);
	await api.post(`/api/v1/issues/${stale.id}/transition`, { action: 'Design complete' });

	await request.dispose();
});

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

const issueUrl = (issue: IssueDetail) =>
	`/issues/${encodeURIComponent(projectName)}/${issue.number}`;

const stateCard = (page: Page) =>
	page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'State', exact: true }) });

/** A transition button, matched the way a screen reader names it. */
const transition = (page: Page, name: string) => stateCard(page).getByRole('button', { name });

/**
 * The requirement lines belonging to a button, reached through the
 * `aria-describedby` that links them — so the lookup itself asserts the
 * association a screen reader relies on.
 */
async function reasons(page: Page, name: string): Promise<Locator> {
	const id = await transition(page, name).getAttribute('aria-describedby');
	expect(id, `${name} should describe its requirement lines`).toBeTruthy();
	return page.locator(`ul[id="${id}"]`);
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Boxes for several elements as of ONE settled layout (`readSettled` in
 * `helpers.ts`): the issue page keeps resolving streamed panels after the card
 * is visible, and two separate `boundingBox()` reads are two different moments
 * (Tines/123).
 */
function boxes(locators: Locator[]): Promise<Box[]> {
	// Bounded, as the hand-rolled loop this replaced was: a layout that never
	// settles should fail here in seconds, not burn the whole test timeout.
	return readSettled(
		() =>
			Promise.all(
				locators.map(async (l) => {
					const box = await l.boundingBox();
					expect(box).not.toBeNull();
					return box!;
				})
			),
		{ timeout: 5_000 }
	);
}

/**
 * The streamed panels have all resolved: nothing left is a skeleton. The
 * transitions are up first — in the card on desktop, in the bar on a phone.
 */
async function settled(page: Page): Promise<void> {
	await expect(
		stateCard(page).or(page.getByTestId('transition-bar')).locator('visible=true')
	).toBeVisible();
	await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
}

test('transitions form one full-width stack with the enabled ones first', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(issueUrl(blocked));
	await settled(page);

	const names = ['Needs more research', 'Cancel', 'Design complete', LONG_TRANSITION];
	const [research, cancel, complete, clarify, card] = await boxes([
		...names.map((n) => transition(page, n)),
		stateCard(page)
	]);

	// One column: same left edge, same width, none wider than the card.
	for (const b of [cancel, complete, clarify]) {
		expect(Math.abs(b.width - research.width)).toBeLessThanOrEqual(1);
		expect(Math.abs(b.x - research.x)).toBeLessThanOrEqual(1);
	}
	expect(research.width).toBeGreaterThan(200);
	for (const b of [research, cancel, complete, clarify]) {
		expect(b.x + b.width).toBeLessThanOrEqual(card.x + card.width);
		expect(b.height).toBeLessThan(48); // no wrapped label doubling a row
	}

	// Enabled first (workflow order puts "Design complete" first), workflow
	// order preserved inside each group.
	expect(research.y).toBeLessThan(cancel.y);
	expect(cancel.y).toBeLessThan(complete.y);
	expect(complete.y).toBeLessThan(clarify.y);

	await expect(transition(page, 'Needs more research')).toBeEnabled();
	await expect(transition(page, 'Cancel')).toBeEnabled();
	await expect(transition(page, 'Design complete')).toBeDisabled();
	await expect(transition(page, LONG_TRANSITION)).toBeDisabled();
});

test('each blocking reason sits under its own button', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(issueUrl(blocked));
	await settled(page);

	const completeReasons = await reasons(page, 'Design complete');
	const clarifyReasons = await reasons(page, LONG_TRANSITION);
	await expect(completeReasons).toContainText('design-doc');
	await expect(completeReasons.getByRole('link', { name: 'Artifacts' })).toHaveAttribute(
		'href',
		'#artifacts'
	);
	await expect(completeReasons).toContainText(DESIGN_DOC_DESCRIPTION.slice(0, 40));
	await expect(clarifyReasons).toContainText('clarification-request');

	// Only the blocked buttons carry lines, and each one lies between its own
	// button and the next — never in a detached list under the whole stack.
	await expect(stateCard(page).locator('ul[id^="transition-req-"]')).toHaveCount(2);
	const [complete, completeWhy, clarify, clarifyWhy] = await boxes([
		transition(page, 'Design complete'),
		completeReasons,
		transition(page, LONG_TRANSITION),
		clarifyReasons
	]);
	expect(completeWhy.y).toBeGreaterThanOrEqual(complete.y + complete.height - 1);
	expect(completeWhy.y + completeWhy.height).toBeLessThanOrEqual(clarify.y + 1);
	expect(clarifyWhy.y).toBeGreaterThanOrEqual(clarify.y + clarify.height - 1);
});

test('a long transition label truncates rather than overflowing the card', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(issueUrl(blocked));
	await settled(page);

	const button = transition(page, LONG_TRANSITION);
	// The accessible name — and the tooltip — still carry the full label.
	await expect(button).toHaveAttribute('title', LONG_TRANSITION);
	const label = button.locator('span').first();
	const clipped = await label.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
	expect(clipped).toBe(true);

	// The target chip is what must survive the clip: it is the second half of
	// the label/target split.
	await expect(button).toContainText('Needs Clarification');
});

test('a satisfied requirement reads as a check under its enabled button', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(issueUrl(fresh));
	await settled(page);

	await expect(transition(page, 'Design complete')).toBeEnabled();
	const why = await reasons(page, 'Design complete');
	await expect(why).toContainText('design-doc is fresh (v1).');

	// Still first in the stack, and its check line still directly under it.
	const [complete, check, research] = await boxes([
		transition(page, 'Design complete'),
		why,
		transition(page, 'Needs more research')
	]);
	expect(complete.y).toBeLessThan(research.y);
	expect(check.y).toBeGreaterThanOrEqual(complete.y + complete.height - 1);
	expect(check.y + check.height).toBeLessThanOrEqual(research.y + 1);
});

test('a stale requirement is reported under its blocked button', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(issueUrl(stale));
	await settled(page);

	const ship = transition(page, 'ship');
	await expect(ship).toBeDisabled();
	const why = await reasons(page, 'ship');
	await expect(why).toContainText('is stale');

	const [button, reason] = await boxes([ship, why]);
	expect(reason.y).toBeGreaterThanOrEqual(button.y + button.height - 1);
});

test('on a phone the transitions live in a bar pinned above the tab bar', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(issueUrl(blocked));
	await settled(page);

	// The State card is a desktop surface; the bar takes its place, on screen
	// without scrolling and sitting just above the tab bar.
	await expect(page.getByRole('heading', { name: 'State', exact: true })).toBeHidden();
	const bar = page.getByTestId('transition-bar');
	const direct = bar.getByRole('button', { name: 'Needs more research' });
	await expect(direct).toBeInViewport();
	const [barBox, tabs] = await boxes([bar, page.getByRole('navigation', { name: 'Primary' })]);
	expect(barBox.y + barBox.height).toBeLessThanOrEqual(tabs.y + 1);

	// A name that does not fit whole is counted, never truncated...
	await expect(bar.getByRole('button', { name: LONG_TRANSITION })).toHaveCount(0);
	await expect(bar.getByRole('button', { name: /more transitions/ })).toBeVisible();

	// ...and the state button opens the sheet with every transition, each
	// blocked one explained exactly as the desktop card would.
	await page.getByRole('button', { name: /^State: Design/ }).click();
	const sheet = page.getByRole('dialog', { name: 'State' });
	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole('button', { name: LONG_TRANSITION })).toBeVisible();
	await expect(sheet.getByRole('button', { name: /^Design complete/ })).toBeDisabled();
	await expect(sheet.getByText(/Needs artifact/).first()).toBeVisible();
});

test('the desktop layout keeps the State card in the right column', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(issueUrl(blocked));
	await settled(page);

	const [card, description, agents] = await boxes([
		stateCard(page),
		page
			.locator('section')
			.filter({ has: page.getByRole('heading', { name: 'Description', exact: true }) }),
		page.locator('section').filter({ has: page.getByRole('heading', { name: 'Agent activity' }) })
	]);
	expect(card.x).toBeGreaterThan(description.x + description.width - 1);
	expect(Math.abs(card.y - description.y)).toBeLessThanOrEqual(1);
	// The rest of the aside still follows the card down the same column.
	expect(agents.y).toBeGreaterThanOrEqual(card.y + card.height - 1);
	expect(Math.abs(agents.x - card.x)).toBeLessThanOrEqual(1);
});

test('the State card does not stretch to fill a tall main column', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(issueUrl(tall));
	await settled(page);

	const [card, description, agents] = await boxes([
		stateCard(page),
		page
			.locator('section')
			.filter({ has: page.getByRole('heading', { name: 'Description', exact: true }) }),
		page.locator('section').filter({ has: page.getByRole('heading', { name: 'Agent activity' }) })
	]);

	// Fixture sanity: with a main column no taller than the aside there is no
	// row height for the grid to distribute, and the rest proves nothing. The
	// threshold is absolute, not a multiple of the card — a stretched card must
	// red the assertions below, not this one.
	expect(description.height).toBeGreaterThan(1500);

	// The aside picks up one `gap-8` below the card, exactly as it did when the
	// card was still a block inside it. Without `lg:grid-rows-[auto_1fr]` the
	// main column's height is shared across both rows and this gap was ~1000px.
	expect(agents.y - (card.y + card.height)).toBeLessThanOrEqual(40);

	// ...and the card's own border ends where its content does, rather than
	// enclosing a screenful of empty space under "Move directly…".
	const slack = await stateCard(page).evaluate((el) => {
		const style = getComputedStyle(el);
		const last = el.lastElementChild;
		if (!last) throw new Error('the State card should have children');
		return (
			el.getBoundingClientRect().bottom -
			parseFloat(style.borderBottomWidth) -
			parseFloat(style.paddingBottom) -
			last.getBoundingClientRect().bottom
		);
	});
	expect(slack).toBeLessThan(4);
});
