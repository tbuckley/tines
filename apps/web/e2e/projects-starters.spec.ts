import type { StarterSummary } from '@tines/shared';
import { expect, test, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, clickUntil, gotoHydrated, runId, signIn } from './helpers';

/**
 * The New-project dialog's "Start from" chooser (Tines/249).
 *
 * Sorts after `artifacts-panel.spec.ts`, whose relative-age assertions are
 * sensitive to what runs before it — do not rename this file to something
 * that sorts earlier.
 *
 * Assertions read the starter *summaries* from the API rather than hardcoding
 * prose, because the starter content is another issue's to change (Tines/250):
 * what is pinned here is the dialog's behaviour, not the words in it.
 *
 * Nothing here asserts on how many workflows exist. Workflows are user-scoped
 * and a starter reuses a structurally identical one, so on a reused server the
 * second run legitimately takes the reuse branch.
 */

let starters: StarterSummary[];
const byId = (id: string): StarterSummary => {
	const found = starters.find((s) => s.id === id);
	if (!found) throw new Error(`starter ${id} missing from the menu`);
	return found;
};

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({
		baseURL: test.info().project.use.baseURL
	});
	const api = apiClient(request, ALICE.apiKey);
	const res = await api.get('/api/v1/projects/starters');
	expect(res.status(), 'the starter menu must load').toBe(200);
	starters = (await body<{ items: StarterSummary[] }>(res)).items;
	await request.dispose();
});

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

/**
 * The project page does not name its default workflow, so the grid card —
 * which does — is where that acceptance criterion is checked. Called from the
 * project page it has just landed on.
 */
async function expectDefaultWorkflow(page: Page, name: string) {
	const href = new URL(page.url()).pathname;
	await page.goto('/projects');
	await expect(
		page.locator(`a[href="${href}"]`).filter({ hasText: `workflow: ${name}` })
	).toHaveCount(1);
}

/** Opens the New-project dialog on an already-hydrated /projects. */
async function openDialog(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'New project' });
	await clickUntil(page.getByRole('button', { name: /New project/ }), async () => {
		await expect(dialog).toBeVisible({ timeout: 2_000 });
	});
	return dialog;
}

test('Blank is preselected and creates a project with only the conventions prompt', async ({
	page
}) => {
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);

	await expect(dialog.getByTestId('starter-blank')).toHaveAttribute('aria-checked', 'true');
	await expect(dialog.getByTestId('starter-code')).toHaveAttribute('aria-checked', 'false');
	// Blank asks for nothing beyond today's form.
	await expect(dialog.getByLabel('Repository URL')).toHaveCount(0);
	// The reworded label, and no developer-only wording (PRD success signal 7).
	await expect(dialog.getByLabel(/How work is done here/)).toBeVisible();
	await expect(dialog.getByText(/commands? that must pass/i)).toHaveCount(0);

	const name = `starter-blank-${runId}`;
	await dialog.getByLabel('Name', { exact: true }).fill(name);
	await dialog.getByLabel(/How work is done here/).fill('Ask before deleting anything.');

	const creates = dialog.getByRole('list', { name: 'This creates' });
	await expect(creates).toHaveText(/Prompt “conventions”/);
	await expect(creates.getByRole('listitem')).toHaveCount(1);

	await dialog.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(/\/projects\/prj_/);
	await expect(page.getByRole('heading', { name })).toBeVisible();
	// Context items are buttons (they open the editor), not links.
	await expect(page.getByRole('button', { name: /^conventions/ })).toBeVisible();
	await expect(page.getByText('No issues in this project yet.')).toBeVisible();
});

test('Code repository asks for a URL, previews the repo item, and creates it', async ({ page }) => {
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);
	const code = byId('code');

	await dialog.getByTestId('starter-code').click();
	await expect(dialog.getByTestId('starter-code')).toHaveAttribute('aria-checked', 'true');
	// Both declared inputs, the optional one marked as such.
	await expect(dialog.getByLabel(code.inputs[0].label, { exact: false })).toBeVisible();
	await expect(dialog.getByLabel(/Branch.*optional/)).toBeVisible();

	// A pristine textarea mirrors the starter's template.
	const conventions = dialog.getByLabel(/How work is done here/);
	await expect(conventions).toHaveValue(code.conventions_template ?? '');

	const name = `starter-code-${runId}`;
	await dialog.getByLabel('Name', { exact: true }).fill(name);
	// The required input is enforced before submit.
	await expect(dialog.getByRole('button', { name: 'Create project' })).toBeDisabled();
	await dialog
		.getByLabel(code.inputs[0].label, { exact: false })
		.fill(`https://github.com/example/widget-${runId}.git`);
	await expect(dialog.getByRole('button', { name: 'Create project' })).toBeEnabled();

	const creates = dialog.getByRole('list', { name: 'This creates' });
	await expect(creates).toHaveText(new RegExp(`Repository “widget-${runId}”`));
	await expect(creates).toHaveText(/\(default\)/);
	await expect(creates).toHaveText(/Prompt “conventions”/);
	await expect(creates).toHaveText(new RegExp(`Issue “${code.creates.first_issue?.title}”`));

	await dialog.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(/\/projects\/prj_/);
	await expect(
		page.getByRole('link', { name: new RegExp(code.creates.first_issue?.title ?? 'nope') })
	).toBeVisible();
	await expect(page.getByRole('button', { name: /^conventions/ })).toBeVisible();
	await expect(page.getByRole('button', { name: new RegExp(`^widget-${runId}`) })).toBeVisible();
	// The starter's own workflow is the project's default — the grid card is
	// where the project page does not say so itself.
	await expectDefaultWorkflow(page, code.creates.workflows.find((w) => w.default)?.name ?? '');
});

test('clearing the prefilled conventions creates a project without one', async ({ page }) => {
	// The dialog sends `initial_prompt` verbatim, so an emptied textarea must
	// mean "no conventions item". Were it sent as `undefined` instead, the
	// server would fall back to the starter's own template and seed the very
	// prompt the user just deleted.
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);
	const code = byId('code');

	await dialog.getByTestId('starter-code').click();
	const name = `starter-noconv-${runId}`;
	await dialog.getByLabel('Name', { exact: true }).fill(name);
	await dialog
		.getByLabel(code.inputs[0].label, { exact: false })
		.fill(`https://github.com/example/noconv-${runId}.git`);

	const conventions = dialog.getByLabel(/How work is done here/);
	await expect(conventions).toHaveValue(code.conventions_template ?? '');
	await conventions.fill('');

	// The preview stops promising it, too.
	const creates = dialog.getByRole('list', { name: 'This creates' });
	await expect(creates).toHaveText(new RegExp(`Repository “noconv-${runId}”`));
	await expect(creates).not.toHaveText(/Prompt “conventions”/);

	await dialog.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(/\/projects\/prj_/);
	await expect(page.getByRole('heading', { name })).toBeVisible();
	// The repo item is there — so the starter did apply — and the prompt is not.
	await expect(page.getByRole('button', { name: new RegExp(`^noconv-${runId}`) })).toBeVisible();
	await expect(page.getByRole('button', { name: /^conventions/ })).toHaveCount(0);
});

test('Plan something together renders the brief into the prefill and the preview', async ({
	page
}) => {
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);
	const plan = byId('plan');

	await dialog.getByTestId('starter-plan').click();
	const brief = `hiring for Q1 ${runId}`;
	await dialog.getByLabel(plan.inputs[0].label, { exact: false }).fill(brief);

	// Both the pristine textarea and the preview follow the brief live.
	await expect(dialog.getByLabel(/How work is done here/)).toHaveValue(new RegExp(brief));
	const creates = dialog.getByRole('list', { name: 'This creates' });
	await expect(creates).toHaveText(new RegExp(brief));

	const name = `starter-plan-${runId}`;
	await dialog.getByLabel('Name', { exact: true }).fill(name);
	await dialog.getByRole('button', { name: 'Create project' }).click();

	await expect(page).toHaveURL(/\/projects\/prj_/);
	const title = plan.creates.first_issue?.title.replace('{{ brief }}', brief) ?? 'nope';
	await expect(page.getByRole('link', { name: title })).toBeVisible();
	await expect(page.getByRole('button', { name: /^conventions/ })).toBeVisible();
	await expectDefaultWorkflow(page, plan.creates.workflows.find((w) => w.default)?.name ?? '');
});

test('switching starters confirms before discarding edited conventions', async ({ page }) => {
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);
	const plan = byId('plan');

	await dialog.getByTestId('starter-code').click();
	const conventions = dialog.getByLabel(/How work is done here/);
	await conventions.fill('Mine, hand-written.');

	// Keep mine: the starter still switches, the text does not.
	await dialog.getByTestId('starter-plan').click();
	const confirm = page.getByRole('alertdialog');
	await expect(confirm.getByText('Replace your conventions?')).toBeVisible();
	await confirm.getByRole('button', { name: 'Keep mine' }).click();
	await expect(dialog.getByTestId('starter-plan')).toHaveAttribute('aria-checked', 'true');
	await expect(conventions).toHaveValue('Mine, hand-written.');

	// Replace: the new starter's template wins.
	await dialog.getByTestId('starter-code').click();
	await expect(page.getByRole('alertdialog').getByText('Replace your conventions?')).toBeVisible();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Replace' }).click();
	await expect(dialog.getByTestId('starter-code')).toHaveAttribute('aria-checked', 'true');
	// Code's template has no placeholders, so it renders verbatim.
	await expect(conventions).toHaveValue(byId('code').conventions_template ?? '');
	// And it is pristine again: switching back to Plan swaps it with no prompt.
	await dialog.getByTestId('starter-plan').click();
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(conventions).not.toHaveValue(byId('code').conventions_template ?? '');
	expect(plan.conventions_template).not.toBeNull();

	// A starter with no template discards the text rather than replacing it,
	// and says so: promising a swap and then emptying the field is a lie.
	const blank = byId('blank');
	expect(blank.conventions_template, 'blank must have no template').toBeNull();
	await conventions.fill('Mine again.');
	await dialog.getByTestId('starter-blank').click();
	const discard = page.getByRole('alertdialog');
	await expect(discard).toContainText(new RegExp(`discards the text you edited`));
	await expect(discard).toContainText(blank.name);
	await expect(discard).not.toContainText(/with its template/);
	await discard.getByRole('button', { name: 'Replace' }).click();
	await expect(conventions).toHaveValue('');
});

test('a starter 422 from the API is surfaced in the dialog, not swallowed', async ({ page }) => {
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);
	const code = byId('code');
	const branch = code.inputs.find((i) => i.key === 'repo_branch');
	expect(branch?.max, 'the branch input must have a server-side cap to violate').toBeGreaterThan(0);

	await dialog.getByTestId('starter-code').click();
	await dialog.getByLabel('Name', { exact: true }).fill(`starter-422-${runId}`);
	await dialog
		.getByLabel(code.inputs[0].label, { exact: false })
		.fill('https://github.com/example/toolong.git');
	// The dialog does not cap this client-side, so the server's 422 is the only
	// thing standing between the user and a confusing silent failure.
	await dialog.getByLabel(/Branch/).fill('b'.repeat((branch?.max ?? 200) + 1));
	await dialog.getByRole('button', { name: 'Create project' }).click();

	await expect(dialog.getByText(/longer than \d+ characters/)).toBeVisible();
	// Still open, with the user's input intact.
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(`starter-422-${runId}`);
});

test('at 390px the chooser stacks and the whole form stays reachable', async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await signIn(context, ALICE.sessionToken);
	const page = await context.newPage();
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);

	const boxes = [];
	for (const starter of starters) {
		const box = await dialog.getByTestId(`starter-${starter.id}`).boundingBox();
		expect(box, `starter-${starter.id} must be laid out`).not.toBeNull();
		boxes.push(box!);
	}
	// Stacked: each card starts below the last, and they share a left edge.
	for (let i = 1; i < boxes.length; i++) {
		expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].y);
		expect(Math.abs(boxes[i].x - boxes[0].x)).toBeLessThan(2);
	}
	// The dialog itself fits the viewport horizontally.
	const dialogBox = (await dialog.boundingBox())!;
	expect(dialogBox.x).toBeGreaterThanOrEqual(0);
	expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(390);

	// Every input remains reachable by scrolling the dialog.
	await dialog.getByTestId('starter-code').click();
	const url = dialog.getByLabel(byId('code').inputs[0].label, { exact: false });
	await url.scrollIntoViewIfNeeded();
	await url.fill('https://github.com/example/phone.git');
	await dialog.getByLabel('Name', { exact: true }).fill(`starter-phone-${runId}`);
	const submit = dialog.getByRole('button', { name: 'Create project' });
	await submit.scrollIntoViewIfNeeded();
	await expect(submit).toBeVisible();
	await expect(submit).toBeEnabled();

	await context.close();
});
