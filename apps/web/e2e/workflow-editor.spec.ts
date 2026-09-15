/**
 * Workflow editor chrome. The page header used to repeat the description that
 * the form below it already holds in an editable field — six lines of prose in
 * a paragraph, then the same six in a textarea, with a lone red Delete button
 * between them on a phone (Tines/133). The header now carries the description
 * only on the read-only system workflow, which has no form to hold it, and
 * Delete moved down into the form's save row.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { apiClient, body, gotoHydrated, signIn } from './helpers';

let workflowName: string;
/** As long as a real workflow's: six lines on a desktop, nine on a phone. */
const description =
	'Backlog → Research → Design → Implementation → Automated Review → Human Review → Merging → Closed (or Canceled). Small, fully-specified tasks may go straight from Backlog to Implementation. Research, Design, and Implementation can park in Needs Clarification to ask a human a blocking question. After human approval, a Merging run brings the PR up to date with main and lands it.';

/** The system workflow seeded by migration 0002, read-only for every user. */
const SYSTEM_WORKFLOW = {
	id: 'wf_standard',
	description: 'The built-in workflow: Open → Human Review → Closed.'
};

let workflowId: string;

test.beforeAll(async ({ apiFor, uniqueName }) => {
	workflowName = uniqueName('Header', { maxLength: 100 });
	const api = apiFor(ALICE);
	const created = await body<{ id: string }>(
		await api.post('/api/v1/workflows', {
			name: workflowName,
			description,
			initial_state: 'Open',
			states: [
				{ name: 'Open', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				{ name: 'Finish', from: 'Open', to: 'Done' },
				{ name: 'Abandon', from: 'Open', to: 'Done' }
			]
		})
	);
	workflowId = created.id;
});

test.use({ signedIn: ALICE });

/** The paragraphs the header renders under the title, in document order. */
const headerParagraphs = (page: Page, title: string | RegExp) =>
	page.getByRole('heading', { level: 1, name: title }).locator('xpath=following-sibling::p');

test('an editable workflow shows the description once, in the form that edits it', async ({
	page
}) => {
	await page.goto(`/workflows/${workflowId}`);
	await expect(page.getByRole('heading', { level: 1, name: workflowName })).toBeVisible();

	// Title, then the meta line — and nothing else.
	const paragraphs = headerParagraphs(page, workflowName);
	await expect(paragraphs).toHaveCount(1);
	await expect(paragraphs).toHaveText(/0 issues use this workflow/);

	await expect(page.getByLabel('Description', { exact: true })).toHaveValue(description);
});

test('an editable workflow can save parallel named actions to one state', async ({ page }) => {
	await gotoHydrated(page, `/workflows/${workflowId}`);
	await expect(page.getByLabel('Action name')).toHaveCount(2);
	await expect(page.getByText('Only one action can lead')).toHaveCount(0);
	const save = page.getByRole('button', { name: 'Save workflow' });
	await expect(save).toBeEnabled();
	const response = page.waitForResponse(
		(res) =>
			res.request().method() === 'PATCH' && res.url().endsWith(`/api/v1/workflows/${workflowId}`)
	);
	await save.click();
	expect((await response).ok()).toBe(true);
	await expect(page.getByLabel('Action name')).toHaveCount(2);
});

test('Delete sits in the save row rather than the header', async ({ page }) => {
	await page.goto(`/workflows/${workflowId}`);
	const form = page.locator('form');
	const deleteButton = form.getByRole('button', { name: 'Delete', exact: true });
	await expect(deleteButton).toBeVisible();
	// Nothing outside the form offers to delete the workflow any more.
	await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(1);

	// Every box in one read: two `boundingBox()` calls are two moments, and the
	// page keeps settling while the live preview draws.
	const row = await form.evaluate((formEl: HTMLFormElement) => {
		const buttons = [...formEl.querySelectorAll('button')];
		const save = buttons.find((b) => b.type === 'submit')!;
		const remove = buttons.find((b) => b.textContent?.trim() === 'Delete')!;
		const s = save.getBoundingClientRect();
		const d = remove.getBoundingClientRect();
		const f = formEl.getBoundingClientRect();
		return {
			centreGap: Math.abs((s.top + s.bottom) / 2 - (d.top + d.bottom) / 2),
			saveRight: s.right,
			deleteLeft: d.left,
			deleteRight: d.right,
			formRight: f.right
		};
	});
	expect(row.centreGap).toBeLessThan(2);
	expect(row.deleteLeft).toBeGreaterThan(row.saveRight);
	expect(row.formRight - row.deleteRight).toBeLessThan(2);
});

test('on a phone the form starts right under the title', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/workflows/${workflowId}`);

	await expect(page.getByLabel('Name', { exact: true })).toBeVisible();

	// The header used to push the Name field past y≈420 of an 844px viewport —
	// nine lines of description before the first control. It now sits in the top
	// quarter, so the form is what the page opens on.
	const nameTop = await page
		.getByLabel('Name', { exact: true })
		.evaluate((el) => el.getBoundingClientRect().top);
	expect(nameTop).toBeLessThan(844 / 3);
});

test('the read-only system workflow keeps its description in the header', async ({ page }) => {
	await page.goto(`/workflows/${SYSTEM_WORKFLOW.id}`);

	// No form here, so the header is the only place the description can go.
	const paragraphs = headerParagraphs(page, /^Standard/);
	await expect(paragraphs).toHaveCount(2);
	await expect(paragraphs.first()).toHaveText(SYSTEM_WORKFLOW.description);
	await expect(paragraphs.last()).toHaveText(/uses? this workflow/);
	await expect(page.getByRole('button', { name: 'Copy to library' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
});
