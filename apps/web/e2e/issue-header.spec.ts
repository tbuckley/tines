import type { IssueDetail, Project } from '@tines/shared';
import type { Locator, Page } from '@playwright/test';

type Box = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import {
	body,
	clickIssueAction,
	gotoHydrated,
	issuePath,
	openIssueActions,
	resetFocus,
	runId
} from './helpers';

/**
 * The line above the issue title (Tines/770). It used to print project →
 * Focus → Move to project… → #n inline, so on a phone the number wrapped
 * alone onto a second line, split from its project by the action links.
 * The actions now live in a ⋯ menu on the back link's row, so the line
 * reads `Project #n` alone.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const projectName = `Launch Room ${runId}`;
// PROJECT_NAME_MAX, as one unbroken token: must truncate, not widen the page.
const longName = `${'x'.repeat(200 - runId.length)}${runId}`;
let issue: IssueDetail;
let longIssue: IssueDetail;

test.beforeAll(async ({ apiFor }) => {
	const api = apiFor(ALICE);
	const create = async (name: string) => {
		const project = await body<Project>(await api.post('/api/v1/projects', { name }));
		return body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, { title: `Header ${runId}` })
		);
	};
	issue = await create(projectName);
	longIssue = await create(longName);
});

test.use({ signedIn: ALICE });

test.beforeEach(async ({ request }) => {
	// With no focus the owner is offered "Focus <project>", so they see the
	// same three items a member sees.
	await resetFocus(request);
});

/** How far the document scrolls past the viewport, in px. 0 when it fits. */
async function overflow(page: Page): Promise<number> {
	return page.evaluate(() => {
		const el = document.documentElement;
		return el.scrollWidth - el.clientWidth;
	});
}

/**
 * Whether two boxes sit on one line: centres, not tops, since a mono span, a
 * sans link and a 32px icon button have different tops on one row.
 */
function sameLine(a: Box, b: Box): boolean {
	return Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) < 8;
}

async function box(locator: Locator): Promise<Box> {
	await expect(locator).toBeVisible();
	const b = await locator.boundingBox();
	expect(b).not.toBeNull();
	return b!;
}

/** Whether the element's text is cut off by its own ellipsis. */
async function truncated(locator: Locator): Promise<boolean> {
	return locator.evaluate((el) => el.scrollWidth > el.clientWidth);
}

test('on a phone the reference line is `Project #n` alone', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await gotoHydrated(page, issuePath(projectName, issue.number));

	const ref = page.getByTestId('issue-ref');
	const linkLocator = ref.getByRole('link', { name: projectName });
	const link = await box(linkLocator);
	const number = await box(ref.getByText(`#${issue.number}`, { exact: true }));

	// Was: #n at x=16 on the second line, under the action links.
	expect(sameLine(number, link)).toBe(true);
	expect(number.x).toBeGreaterThan(link.x + link.width - 1);
	expect(await truncated(linkLocator)).toBe(false);
	// The actions are no longer inline; they wait behind the menu.
	await expect(page.getByRole('button', { name: `Focus ${projectName}` })).toHaveCount(0);
	await expect(page.getByTestId('move-to-project')).toBeHidden();
	expect(await overflow(page)).toBe(0);
});

test('the ⋯ menu sits right of Back, on its line, and holds both actions', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await gotoHydrated(page, issuePath(projectName, issue.number));

	const back = await box(page.getByTestId('issue-back'));
	const trigger = await box(page.getByRole('button', { name: 'Issue actions' }));
	expect(sameLine(trigger, back)).toBe(true);
	// Flush with the content's right edge (16px page padding), not after Back.
	expect(trigger.x + trigger.width).toBeGreaterThan(PHONE.width - 24);
	expect(trigger.x).toBeGreaterThan(back.x + back.width);

	const menu = await openIssueActions(page);
	await expect(menu.getByRole('menuitem', { name: `Focus ${projectName}` })).toBeVisible();
	await expect(menu.getByRole('menuitem', { name: 'Move to project…' })).toBeVisible();
	const panel = await box(menu);
	expect(panel.x).toBeGreaterThanOrEqual(0);
	expect(panel.x + panel.width).toBeLessThanOrEqual(PHONE.width);

	// Choosing an item works: Move to project… opens the transfer dialog.
	await page.keyboard.press('Escape');
	await clickIssueAction(page, page.getByTestId('move-to-project'), page.getByRole('dialog'));
});

test('on a desktop the ⋯ menu is at the far right of the Back row', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await gotoHydrated(page, issuePath(projectName, issue.number));

	const back = await box(page.getByTestId('issue-back'));
	const trigger = await box(page.getByRole('button', { name: 'Issue actions' }));
	const heading = await box(page.getByRole('heading', { level: 1 }));
	expect(sameLine(trigger, back)).toBe(true);
	expect(trigger.x).toBeGreaterThan(DESKTOP.width / 2);
	expect(trigger.y + trigger.height).toBeLessThan(heading.y);
	await expect(page.getByRole('button', { name: `Focus ${projectName}` })).toHaveCount(0);
});

test('a 200-character project name does not widen the phone page', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await gotoHydrated(page, issuePath(longName, longIssue.number));
	await expect(page.getByTestId('issue-ref')).toBeVisible();

	expect(await overflow(page)).toBe(0);

	// The name ellipsises rather than collapsing, and #n stays on screen.
	const ref = page.getByTestId('issue-ref');
	const link = await box(ref.getByRole('link', { name: longName }));
	expect(link.width).toBeGreaterThan(100);
	expect(link.width).toBeLessThan(PHONE.width);
	const number = await box(ref.getByText(`#${longIssue.number}`, { exact: true }));
	expect(number.x + number.width).toBeLessThanOrEqual(PHONE.width);

	// The menu item for the long name truncates inside the menu, too.
	const trigger = await box(page.getByRole('button', { name: 'Issue actions' }));
	expect(trigger.x + trigger.width).toBeLessThanOrEqual(PHONE.width);
	const menu = await openIssueActions(page);
	const focus = await box(menu.getByRole('menuitem', { name: `Focus ${longName}` }));
	expect(focus.x + focus.width).toBeLessThanOrEqual(PHONE.width);
	expect(await overflow(page)).toBe(0);
});
