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
 * title, then the rest.
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
