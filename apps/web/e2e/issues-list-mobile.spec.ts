import type { IssueDetail, Project, WorkflowResponse } from '@tines/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, runId, signIn } from './helpers';

/**
 * An issue row at both widths. On a phone the title is the whole first line
 * (wrapping to two, never fewer than the row's full width — Tines/126 was a
 * title squeezed to 108px beside a "Needs Clarification" badge) and the
 * state, ref, signals, labels and time share one metadata line beneath it.
 * From `sm` up the row is a single 40px line in reading order: state, ref,
 * title, then the rest. The category tab strip above the rows is covered at
 * the foot of this file.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/**
 * The longest and one of the shortest state names in the Engineering
 * workflow: the widest spread, which is what made the old truncation ragged.
 */
const LONG_STATE = 'Needs Clarification';
const SHORT_STATE = 'Design';

/** Long enough to wrap at 390px whatever the state cell does. */
const LONG_TITLE = `USER_GUIDE.md refers to a --json flag that no command actually accepts`;
const SHORT_STATE_TITLE = `Full-text search across issue descriptions and comment bodies`;

const projectName = `issues-list-mobile-${runId}`;
let project: Project;
/** Sits in `Needs Clarification` — the widest state cell. */
let clarifying: IssueDetail;
/** Transitioned to `Design` — a much narrower one. */
let designing: IssueDetail;
/** A duplicate of `clarifying`, so its row carries the `dup` signal. */
let duplicate: IssueDetail;

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({
		baseURL: test.info().project.use.baseURL
	});
	const api = apiClient(request, ALICE.apiKey);
	project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));

	const workflow = await body<WorkflowResponse>(
		await api.post('/api/v1/workflows', {
			name: `Mobile list ${runId}`,
			initial_state: LONG_STATE,
			states: [
				{ name: LONG_STATE, category: 'active' },
				{ name: SHORT_STATE, category: 'active' }
			],
			transitions: [{ name: 'design', from: LONG_STATE, to: SHORT_STATE }]
		})
	);

	const create = async (title: string) =>
		body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: `${title} ${runId}`,
				workflow_id: workflow.id
			})
		);
	clarifying = await create(LONG_TITLE);
	designing = await create(SHORT_STATE_TITLE);
	await api.post(`/api/v1/issues/${designing.id}/transition`, { action: 'design' });

	duplicate = await create(`Duplicate of the clarification issue, reported separately`);
	await api.post(`/api/v1/issues/${duplicate.id}/links`, {
		kind: 'duplicate_of',
		issue_id: clarifying.id
	});

	await request.dispose();
});

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

/** The issues list, filtered to this spec's project so only its rows show. */
const listUrl = `/issues?project=${encodeURIComponent(projectName)}`;

const row = (page: Page, issue: IssueDetail): Locator =>
	page.getByRole('link', { name: new RegExp(`#${issue.number}\\b`) });

/** The title text — the box the badge used to eat. */
const title = (row: Locator): Locator => row.locator('.vt-shared').first();
/** The state cell: glyph plus name, named for the view transition. */
const stateCell = (row: Locator): Locator => row.locator('[style*="issue-state"]');
/** The `#number`; bare, since the list is filtered to one project. */
const number = (row: Locator, issue: IssueDetail): Locator =>
	row.getByText(`#${issue.number}`, { exact: true });
/** The metadata wrapper: the row's only child div, `contents` at `sm`+. */
const metaLine = (row: Locator): Locator => row.locator('> div');

const display = (locator: Locator): Promise<string> =>
	locator.evaluate((el) => getComputedStyle(el).display);

async function box(locator: Locator) {
	const b = await locator.boundingBox();
	expect(b).not.toBeNull();
	return b!;
}

test('every title on a phone gets the same readable width', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(listUrl);

	const long = row(page, clarifying);
	const short = row(page, designing);
	await expect(long).toBeVisible();
	await expect(short).toBeVisible();

	// Was 108px next to "Needs Clarification" and 178px next to "Design".
	const longTitle = await box(title(long));
	const shortTitle = await box(title(short));
	expect(longTitle.width).toBeGreaterThan(240);
	expect(shortTitle.width).toBeGreaterThan(240);

	// And the same width, so the two rows wrap at the same character.
	expect(Math.abs(longTitle.width - shortTitle.width)).toBeLessThan(2);
});

test('the state sits on the metadata line under the title on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(listUrl);

	const rows = [row(page, clarifying), row(page, designing)];
	const heights: number[] = [];
	for (const r of rows) {
		await expect(r).toBeVisible();
		const rowBox = await box(r);
		const titleBox = await box(title(r));
		const stateBox = await box(stateCell(r));

		// Second line: below the title, and hung at the row's own left edge,
		// so the line gets the row's full width.
		expect(await display(metaLine(r))).toBe('flex');
		expect(stateBox.y).toBeGreaterThan(titleBox.y + titleBox.height - 1);
		expect(stateBox.x - rowBox.x).toBeLessThan(24);
		// The ref follows the state on that line; the time ends it.
		const numberBox = await box(number(r, r === rows[0] ? clarifying : designing));
		expect(numberBox.x).toBeGreaterThan(stateBox.x + stateBox.width - 1);
		expect(Math.abs(numberBox.y - stateBox.y)).toBeLessThan(8);
		heights.push(rowBox.height);
	}

	// Both titles wrap to two lines here, so the rows are the same height —
	// and three lines at most: uniform rows a phone screen can be scanned down.
	expect(heights[0]).toBeLessThan(90);
	expect(Math.abs(heights[0] - heights[1])).toBeLessThan(2);
});

test('signals ride the metadata line on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(listUrl);

	const dup = row(page, duplicate);
	await expect(dup).toBeVisible();

	// The marker is on the second line, after the ref, and costs no height:
	// the duplicate's row is the same height as a plain two-line one.
	const marker = dup.getByText('dup', { exact: true });
	await expect(marker).toBeInViewport();
	const markerBox = await box(marker);
	const stateBox = await box(stateCell(dup));
	expect(
		Math.abs(markerBox.y + markerBox.height / 2 - (stateBox.y + stateBox.height / 2))
	).toBeLessThan(6);
	expect(markerBox.x).toBeGreaterThan(stateBox.x + stateBox.width);
	expect(Math.abs((await box(dup)).height - (await box(row(page, designing))).height)).toBeLessThan(
		2
	);
	expect((await box(title(dup))).width).toBeGreaterThan(240);
});

test('a desktop row is a single line: state, ref, title', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(listUrl);

	for (const issue of [clarifying, designing]) {
		const r = row(page, issue);
		await expect(r).toBeVisible();
		expect((await box(r)).height).toBeLessThan(48);

		// `sm:contents` dissolves the mobile wrapper, so the state, ref and
		// title are the anchor's own flex children, on one line. Without it the
		// row still measures as one line — only the computed display catches
		// the wrapper surviving into the desktop layout.
		expect(await display(metaLine(r))).toBe('contents');
		const numberBox = await box(number(r, issue));
		const titleBox = await box(title(r));
		const stateBox = await box(stateCell(r));
		expect(
			Math.abs(stateBox.y + stateBox.height / 2 - (titleBox.y + titleBox.height / 2))
		).toBeLessThan(6);
		expect(stateBox.x).toBeLessThan(numberBox.x);
		expect(numberBox.x).toBeLessThan(titleBox.x);

		// Filtered to one project, the ref is the bare number.
		await expect(r.getByText(projectName)).toHaveCount(0);
	}

	// Every title starts at the same x, whatever the state name's length: the
	// state is a fixed column, not a badge the title trails.
	const longStateTitle = await box(title(row(page, clarifying)));
	const shortStateTitle = await box(title(row(page, designing)));
	expect(Math.abs(longStateTitle.x - shortStateTitle.x)).toBeLessThan(1);
});

test('the unfiltered list shows the project in each ref', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto('/issues');

	const r = row(page, clarifying).filter({ hasText: projectName });
	await expect(r).toBeVisible();
	await expect(r.getByText(`${projectName}/`, { exact: true })).toBeVisible();
	await expect(number(r, clarifying)).toBeVisible();
});

test('a desktop row on the project page stays a single line', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(`/projects/${project.id}`);

	// `showProject={false}` here — the other call site of the same component.
	const r = row(page, clarifying);
	await expect(r).toBeVisible();
	expect((await box(r)).height).toBeLessThan(48);
	expect(await display(metaLine(r))).toBe('contents');

	const numberBox = await box(number(r, clarifying));
	const titleBox = await box(title(r));
	const stateBox = await box(stateCell(r));
	expect(
		Math.abs(stateBox.y + stateBox.height / 2 - (titleBox.y + titleBox.height / 2))
	).toBeLessThan(6);
	expect(stateBox.x).toBeLessThan(numberBox.x);
	expect(numberBox.x).toBeLessThan(titleBox.x);
	await expect(r.getByText(projectName)).toHaveCount(0);
});

/**
 * The category tab strip (Tines/180). On a phone the five tabs are ~490px
 * wide in a ~366px container, so the strip scrolls sideways. It used to cut
 * "Awaiting" mid-tab against a hard border with Done off-screen and nothing
 * saying it scrolled: now whichever edge still hides tabs is faded, the tabs
 * snap so none rests half-cut, and the selected tab is scrolled into view.
 * From `sm` up nothing overflows, so there is no fade and no scrolling.
 */

const strip = (page: Page): Locator => page.getByRole('navigation', { name: 'Category' });
/** Tabs are named with their count ("Done 0"), so match the label as a word. */
const tab = (page: Page, name: string): Locator =>
	strip(page).getByRole('link', { name: new RegExp(`^${name}\\b`) });

const TABS = ['Open', 'Backlog', 'Active', 'Awaiting', 'Done'];

/** How far the nav can still be scrolled sideways: 0 when nothing overflows. */
const overflow = (page: Page): Promise<number> =>
	strip(page).evaluate((el) => el.scrollWidth - el.clientWidth);

const stripStyle = (page: Page) =>
	strip(page).evaluate((el) => {
		const s = getComputedStyle(el);
		return { mask: s.maskImage, snapType: s.scrollSnapType, scrollLeft: el.scrollLeft };
	});

/**
 * Which edge the strip fades, read off the computed gradient's end stops
 * (`transparent` computes to `rgba(0, 0, 0, 0)`). Polled by every caller: the
 * mask lands on the first laid-out frame after hydration, not before it.
 */
async function fadedEdges(page: Page) {
	const { mask } = await stripStyle(page);
	if (mask === 'none') return { masked: false, left: false, right: false };
	return {
		masked: true,
		left: /\(to right, rgba\(0, 0, 0, 0\) 0px/.test(mask),
		right: /rgba\(0, 0, 0, 0\) 100%\)$/.test(mask)
	};
}

const expectFade = (page: Page, edges: { left: boolean; right: boolean }) =>
	expect.poll(() => fadedEdges(page)).toEqual({ masked: true, ...edges });

/** The width of the fade at either edge, as the bar renders it. */
const FADE = 24;

/**
 * The selected tab, whole *and* out of the fade: a tab under the fade is
 * hidden as surely as one past the container's edge, so `toBeInViewport`
 * alone would pass on the defect this pins.
 */
async function expectSelectedClear(page: Page, name: string) {
	const on = tab(page, name);
	await expect(on).toHaveAttribute('aria-current', 'page');
	await expect(on).toBeInViewport({ ratio: 1 });
	await expect
		.poll(async () => {
			const edges = await fadedEdges(page);
			const t = await box(on);
			const s = await box(strip(page));
			return {
				clearOfLeftFade: t.x >= s.x + (edges.left ? FADE : 0) - 1,
				clearOfRightFade: t.x + t.width <= s.x + s.width - (edges.right ? FADE : 0) + 1
			};
		})
		.toEqual({ clearOfLeftFade: true, clearOfRightFade: true });
}

test.describe('the category tab strip', () => {
	test('the phone strip fades the edge that hides tabs', async ({ page }) => {
		await page.setViewportSize(PHONE);
		await page.goto(listUrl);
		await expect(tab(page, 'Open')).toBeVisible();

		// It really does overflow — the fade is describing something.
		expect(await overflow(page)).toBeGreaterThan(0);

		// At rest: Open is flush at the left (snapped, so within a pixel of the
		// pill's own padding), Done behind a fade at the right and nowhere else.
		expect((await stripStyle(page)).scrollLeft).toBeLessThanOrEqual(1);
		await expectFade(page, { left: false, right: true });

		// Swiped to the end, the fade swaps sides and Done is fully readable.
		await strip(page).evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: 'instant' }));
		await expect(tab(page, 'Done')).toBeInViewport({ ratio: 1 });
		await expectFade(page, { left: true, right: false });
	});

	test('no fade once every tab fits', async ({ page }) => {
		// The pair for the test above: an unmasked strip must mean "nothing
		// hidden", not "the mask never ran".
		await page.setViewportSize(DESKTOP);
		await page.goto(listUrl);
		await expect(tab(page, 'Open')).toBeVisible();

		expect(await overflow(page)).toBe(0);
		await expect.poll(() => fadedEdges(page)).toEqual({ masked: false, left: false, right: false });

		// One line, and the strip is not a scroller at this width.
		const ys: number[] = [];
		for (const name of TABS) ys.push((await box(tab(page, name))).y);
		for (const y of ys) expect(Math.abs(y - ys[0])).toBeLessThan(2);
		expect(await strip(page).evaluate((el) => getComputedStyle(el).overflowX)).toBe('visible');
	});

	test('a tab never rests half-cut', async ({ page }) => {
		await page.setViewportSize(PHONE);
		await page.goto(listUrl);
		await expect(tab(page, 'Open')).toBeVisible();

		// Snapping is the strip's job, not each tab's: assert both halves.
		// `proximity` is the initial strictness, so it serializes away — "x"
		// alone is the proof it is not the `mandatory` this deliberately avoids.
		expect((await stripStyle(page)).snapType).toBe('x');
		for (const name of TABS) {
			const align = await tab(page, name).evaluate((el) => getComputedStyle(el).scrollSnapAlign);
			expect(align, `${name} tab`).toContain('start');
		}

		// And behaviourally: nudged a few pixels off a snap position, the strip
		// settles back onto one instead of resting mid-tab. That correction is
		// also what used to swallow a small programmatic reveal, which is why
		// `revealActive` targets a snap position rather than an offset.
		const settled = await strip(page).evaluate(async (el) => {
			const pad = parseFloat(getComputedStyle(el).scrollPaddingLeft) || 0;
			const max = el.scrollWidth - el.clientWidth;
			const origin = el.getBoundingClientRect().left - el.scrollLeft;
			const snaps = [...el.querySelectorAll('a[href]')].map((node) =>
				Math.min(Math.max(node.getBoundingClientRect().left - origin - pad, 0), max)
			);
			el.scrollTo({ left: snaps[1] + 6, behavior: 'instant' });
			await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
			return { scrollLeft: el.scrollLeft, snaps };
		});
		expect(Math.min(...settled.snaps.map((x) => Math.abs(x - settled.scrollLeft)))).toBeLessThan(2);
	});

	test('a filtered load shows its selected tab', async ({ page }) => {
		await page.setViewportSize(PHONE);
		// The strip loaded at scrollLeft 0, so the highlighted tab was
		// off-screen on exactly the load that needed it.
		await page.goto(`${listUrl}&category=done`);

		const done = tab(page, 'Done');
		await expect(done).toHaveAttribute('aria-current', 'page');
		await expect(done).toBeInViewport({ ratio: 1 });
		// Scrolled to reach it, and clear of the fade rather than under it.
		expect((await stripStyle(page)).scrollLeft).toBeGreaterThan(0);
		const doneBox = await box(done);
		expect(doneBox.x + doneBox.width).toBeLessThan(PHONE.width - 16);
	});

	test('the 320px strip fades and still reaches Done', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 568 });
		await page.goto(listUrl);
		await expect(tab(page, 'Open')).toBeVisible();

		expect(await overflow(page)).toBeGreaterThan(0);
		await expectFade(page, { left: false, right: true });

		await tab(page, 'Done').click();
		await expect(page).toHaveURL(/category=done/);
		await expect(tab(page, 'Done')).toBeInViewport({ ratio: 1 });
	});

	/**
	 * `awaiting_human` is the small-correction case: the reveal needs ~29px at
	 * 390, which `snap-proximity` used to swallow whole, leaving the selected
	 * tab clipped by 4px and its count rendering at a third alpha under the
	 * fade — the issue's original symptom, on the highlighted tab.
	 */
	test('a filtered load on a mid-strip category clears the fade', async ({ page }) => {
		for (const size of [PHONE, { width: 320, height: 568 }]) {
			await page.setViewportSize(size);
			await page.goto(`${listUrl}&category=awaiting_human`);
			await expect(tab(page, 'Open')).toBeVisible();
			await expectSelectedClear(page, 'Awaiting');
		}

		// And `done=1`, whose selected tab is the sixth "All" one the strip
		// only grows when it is on.
		await page.setViewportSize(PHONE);
		await page.goto(`${listUrl}&done=1`);
		await expect(tab(page, 'All')).toBeVisible();
		await expectSelectedClear(page, 'All');
	});

	test('tapping a mid-strip tab leaves it clear of the fade', async ({ page }) => {
		await page.setViewportSize(PHONE);
		await page.goto(listUrl);
		await expect(tab(page, 'Open')).toBeVisible();

		await tab(page, 'Awaiting').click();
		await expect(page).toHaveURL(/category=awaiting_human/);
		await expectSelectedClear(page, 'Awaiting');
	});

	test('the project page strip fades the same way', async ({ page }) => {
		await page.setViewportSize(PHONE);
		await page.goto(`/projects/${project.id}`);
		await expect(tab(page, 'Open')).toBeVisible();

		expect(await overflow(page)).toBeGreaterThan(0);
		await expectFade(page, { left: false, right: true });
	});
});
