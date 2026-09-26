import type { IssueDetail, Project } from '@tines/shared';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { body, issuePath, resetFocus, runId } from './helpers';

/**
 * The line above the issue title (Tines/770). It used to print project →
 * Focus → Move to project… → #n inline, so on a phone the number wrapped
 * alone onto a second line, split from its project by the action links.
 * The reference `Project #n` now comes first as one unit and the actions
 * are what wrap.
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

async function box(locator: Locator) {
	await expect(locator).toBeVisible();
	const b = await locator.boundingBox();
	expect(b).not.toBeNull();
	return b!;
}

test('on a phone the number stays on the line with its project', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(issuePath(projectName, issue.number));
	await expect(page.getByRole('button', { name: `Focus ${projectName}` })).toBeVisible();

	const ref = page.getByTestId('issue-ref');
	const link = await box(ref.getByRole('link', { name: projectName }));
	const number = await box(ref.getByText(`#${issue.number}`, { exact: true }));

	// Was: #n at x=16 on the second line, under the action links.
	expect(Math.abs(number.y - link.y)).toBeLessThanOrEqual(1);
	expect(number.x).toBeGreaterThan(link.x + link.width - 1);
	expect(await overflow(page)).toBe(0);
});

test('on a desktop the reference comes first, then the actions', async ({ page }) => {
	await page.setViewportSize(DESKTOP);
	await page.goto(issuePath(projectName, issue.number));

	const number = await box(
		page.getByTestId('issue-ref').getByText(`#${issue.number}`, { exact: true })
	);
	const focus = await box(page.getByRole('button', { name: `Focus ${projectName}` }));
	const move = await box(page.getByTestId('move-to-project'));

	expect(number.x).toBeLessThan(focus.x);
	expect(focus.x).toBeLessThan(move.x);
	expect(Math.abs(focus.y - number.y)).toBeLessThanOrEqual(1);
	expect(Math.abs(move.y - number.y)).toBeLessThanOrEqual(1);
});

test('a 200-character project name does not widen the phone page', async ({ page }) => {
	await page.setViewportSize(PHONE);
	await page.goto(issuePath(longName, longIssue.number));
	const focusButton = page.getByRole('button', { name: `Focus ${longName}` });
	await expect(focusButton).toBeVisible();

	expect(await overflow(page)).toBe(0);

	// The name ellipsises rather than collapsing, and #n stays on screen.
	const ref = page.getByTestId('issue-ref');
	const link = await box(ref.getByRole('link', { name: longName }));
	expect(link.width).toBeGreaterThan(100);
	expect(link.width).toBeLessThan(PHONE.width);
	const number = await box(ref.getByText(`#${longIssue.number}`, { exact: true }));
	expect(number.x + number.width).toBeLessThanOrEqual(PHONE.width);

	const focus = await box(focusButton);
	expect(focus.x + focus.width).toBeLessThanOrEqual(PHONE.width);
});
