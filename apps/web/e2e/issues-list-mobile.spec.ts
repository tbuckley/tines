import type { IssueDetail, Project, WorkflowResponse } from '@tines/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, runId, signIn } from './helpers';

/**
 * An issue row on a phone (Tines/126): the row was one flex line and the
 * state badge is `white-space: nowrap`, so the title cell — the only
 * shrinkable thing in it — was all that gave. Measured at 390px: the title
 * span was 108px next to a "Needs Clarification" badge and 178px next to
 * "Design", i.e. ~15 readable characters and a different truncation point on
 * every row. The metadata now drops to a second line below `sm`, so every
 * title gets the same full-width cell and every row the same 51px → 73px
 * height. Desktop must stay a single line, in the same order.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/**
 * The longest and one of the shortest state names in the Engineering
 * workflow: the widest badge spread, which is what made the old truncation
 * ragged.
 */
const LONG_STATE = 'Needs Clarification';
const SHORT_STATE = 'Design';

/** Long enough to truncate at 390px whatever the badge does. */
const LONG_TITLE = `USER_GUIDE.md refers to a --json flag that no command actually accepts`;
const SHORT_STATE_TITLE = `Full-text search across issue descriptions and comment bodies`;

const projectName = `issues-list-mobile-${runId}`;
let project: Project;
/** Sits in `Needs Clarification` — the widest badge. */
let clarifying: IssueDetail;
/** Transitioned to `Design` — a much narrower badge. */
let designing: IssueDetail;
/** A duplicate of `clarifying`, so its row carries the `dup` marker. */
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

/** The truncating title span — the box the badge used to eat. */
const title = (row: Locator): Locator => row.locator('.vt-shared').first();
const badge = (row: Locator): Locator => row.locator('.state-badge');

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

	// And the same width, so the two rows truncate at the same character.
	expect(Math.abs(longTitle.width - shortTitle.width)).toBeLessThan(2);
});

test('the state badge sits on its own line under the title on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(listUrl);

	const rows = [row(page, clarifying), row(page, designing)];
	const heights: number[] = [];
	for (const r of rows) {
		await expect(r).toBeVisible();
		const rowBox = await box(r);
		const titleBox = await box(title(r));
		const badgeBox = await box(badge(r));

		// Second line: below the title, and hung under it rather than under
		// the `#number` column (`pl-15`).
		expect(badgeBox.y).toBeGreaterThan(titleBox.y + 15);
		expect(Math.abs(badgeBox.x - titleBox.x)).toBeLessThan(4);
		heights.push(rowBox.height);
	}

	// Two lines, not more: uniform rows a phone screen can be scanned down.
	expect(heights[0]).toBeLessThan(90);
	expect(Math.abs(heights[0] - heights[1])).toBeLessThan(2);
});

test('markers still render inside the title cell on a phone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(listUrl);

	const dup = row(page, duplicate);
	await expect(dup).toBeVisible();

	// Accepted trade-off, not a regression: markers stay inline after the
	// title and wrap inside the cell, so a marker row is taller than a plain
	// one. It must still be on screen and readable.
	const marker = dup.getByText('dup', { exact: true });
	await expect(marker).toBeInViewport();
	expect((await box(dup)).height).toBeGreaterThanOrEqual((await box(row(page, designing))).height);
	expect((await box(title(dup))).width).toBeGreaterThan(240);
});

test('a desktop row stays a single line in the same order', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(listUrl);

	for (const issue of [clarifying, designing]) {
		const r = row(page, issue);
		await expect(r).toBeVisible();
		expect((await box(r)).height).toBeLessThan(60);

		// `sm:contents` dissolves the mobile wrapper, so the number, title and
		// badge are still the anchor's own flex children, on one line.
		const numberBox = await box(r.getByText(`#${issue.number}`, { exact: true }));
		const titleBox = await box(title(r));
		const badgeBox = await box(badge(r));
		expect(Math.abs(badgeBox.y - titleBox.y)).toBeLessThan(12);
		expect(numberBox.x).toBeLessThan(titleBox.x);
		expect(titleBox.x).toBeLessThan(badgeBox.x);

		// The project name is rendered by the dissolved wrapper too.
		await expect(r.getByText(projectName, { exact: true })).toBeVisible();
	}
});

test('a desktop row on the project page stays a single line', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(`/projects/${project.id}`);

	// `showProject={false}` here, so the wrapper holds only the badge and the
	// time — the other call site of the same component.
	const r = row(page, clarifying);
	await expect(r).toBeVisible();
	expect((await box(r)).height).toBeLessThan(60);

	const numberBox = await box(r.getByText(`#${clarifying.number}`, { exact: true }));
	const titleBox = await box(title(r));
	const badgeBox = await box(badge(r));
	expect(Math.abs(badgeBox.y - titleBox.y)).toBeLessThan(12);
	expect(numberBox.x).toBeLessThan(titleBox.x);
	expect(titleBox.x).toBeLessThan(badgeBox.x);
});
