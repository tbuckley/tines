/**
 * Workflow editor chrome. The page header used to repeat the description that
 * the form below it already holds in an editable field — six lines of prose in
 * a paragraph, then the same six in a textarea, with a lone red Delete button
 * between them on a phone (Tines/133). The header now carries the description
 * only on the read-only system workflow, which has no form to hold it, and
 * Delete moved down into the form's save row.
 */
import { expect, test, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, gotoHydrated, runId, signIn } from './helpers';

const workflowName = `Header ${runId}`;
const wideWorkflowName = `Wide preview ${runId}`;
/** As long as a real workflow's: six lines on a desktop, nine on a phone. */
const description =
	'Backlog → Research → Design → Implementation → Automated Review → Human Review → Merging → Closed (or Canceled). Small, fully-specified tasks may go straight from Backlog to Implementation. Research, Design, and Implementation can park in Needs Clarification to ask a human a blocking question. After human approval, a Merging run brings the PR up to date with main and lands it.';

/** The system workflow seeded by migration 0002, read-only for every user. */
const SYSTEM_WORKFLOW = {
	id: 'wf_standard',
	description: 'The built-in workflow: Open → Human Review → Closed.'
};

let workflowId: string;
let wideWorkflowId: string;

const previewGeometry = async (page: Page) => {
	const region = page.getByRole('region', { name: 'Live preview' });
	return region.evaluate((regionEl) => {
		const svg = regionEl.querySelector('svg')!;
		const heading = document.getElementById(regionEl.getAttribute('aria-labelledby')!)!;
		const viewBoxWidth = svg.viewBox.baseVal.width;
		return {
			svgRatio: svg.getBoundingClientRect().width / viewBoxWidth,
			regionClientWidth: regionEl.clientWidth,
			regionScrollWidth: regionEl.scrollWidth,
			regionScrollLeft: regionEl.scrollLeft,
			headingLeft: heading.getBoundingClientRect().left,
			documentClientWidth: document.documentElement.clientWidth,
			documentScrollWidth: document.documentElement.scrollWidth
		};
	});
};

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({
		baseURL: test.info().project.use.baseURL
	});
	const api = apiClient(request, ALICE.apiKey);
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

	const states = Array.from({ length: 10 }, (_, index) => ({
		name: `Engineering state ${index + 1}`,
		category: index === 9 ? ('done' as const) : ('active' as const)
	}));
	const transitions = Array.from({ length: 9 }, (_, index) => ({
		name: `Advance ${index + 1}`,
		from: states[index].name,
		to: states[index + 1].name
	}));
	for (let source = 1; source < states.length && transitions.length < 30; source += 1) {
		for (let target = 0; target < source && transitions.length < 30; target += 1) {
			transitions.push({
				name: `Return ${source + 1} to ${target + 1}`,
				from: states[source].name,
				to: states[target].name
			});
		}
	}
	const wide = await body<{ id: string }>(
		await api.post('/api/v1/workflows', {
			name: wideWorkflowName,
			description: 'A dense workflow used to verify the live preview remains readable.',
			initial_state: states[0].name,
			states,
			transitions
		})
	);
	wideWorkflowId = wide.id;
	await request.dispose();
});

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

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

test('a wide live preview keeps intrinsic scale and scrolls locally', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await gotoHydrated(page, `/workflows/${wideWorkflowId}`);

	const region = page.getByRole('region', { name: 'Live preview' });
	await expect(region.getByText('Return 7 to 6', { exact: true })).toBeAttached();
	const before = await previewGeometry(page);
	expect(before.svgRatio).toBeCloseTo(1, 2);
	expect(before.regionScrollWidth).toBeGreaterThan(before.regionClientWidth);
	expect(before.documentScrollWidth - before.documentClientWidth).toBeLessThanOrEqual(1);

	await region.focus();
	await expect(region).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect.poll(async () => (await previewGeometry(page)).regionScrollLeft).toBeGreaterThan(0);
	expect((await previewGeometry(page)).headingLeft).toBeCloseTo(before.headingLeft, 1);

	const renamedAction = 'Advance with a substantially longer action label';
	await page.getByLabel('Action name').first().fill(renamedAction);
	await expect(region.getByText(renamedAction, { exact: true })).toBeVisible();
	const afterEdit = await previewGeometry(page);
	expect(afterEdit.svgRatio).toBeCloseTo(1, 2);
	expect(afterEdit.regionScrollWidth).toBeGreaterThan(afterEdit.regionClientWidth);
	expect(afterEdit.documentScrollWidth - afterEdit.documentClientWidth).toBeLessThanOrEqual(1);
});

test('a wide live preview remains contained and scrollable on a phone', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await gotoHydrated(page, `/workflows/${wideWorkflowId}`);

	const region = page.getByRole('region', { name: 'Live preview' });
	await region.scrollIntoViewIfNeeded();
	const before = await previewGeometry(page);
	expect(before.svgRatio).toBeCloseTo(1, 2);
	expect(before.regionScrollWidth).toBeGreaterThan(before.regionClientWidth);
	expect(before.documentScrollWidth - before.documentClientWidth).toBeLessThanOrEqual(1);
	await region.evaluate((el) => {
		el.scrollLeft = 100;
	});
	await expect.poll(async () => (await previewGeometry(page)).regionScrollLeft).toBeGreaterThan(0);
});

test('graphs outside the editor keep their fitted defaults', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/workflows/${SYSTEM_WORKFLOW.id}`);
	const standardGraph = page.getByRole('img', { name: 'Workflow graph' });
	const standard = await standardGraph.evaluate((svg) => ({
		width: svg.getBoundingClientRect().width,
		containerWidth: svg.parentElement!.clientWidth
	}));
	expect(standard.width).toBeLessThanOrEqual(standard.containerWidth + 1);

	await page.goto('/workflows');
	await page.locator('details').evaluateAll((details) => {
		for (const detail of details) detail.open = true;
	});
	const card = page
		.getByRole('heading', { level: 2, name: wideWorkflowName })
		.locator('xpath=ancestor::a');
	const compact = await card.getByRole('img', { name: 'Workflow graph' }).evaluate((svg) => ({
		width: svg.getBoundingClientRect().width,
		containerWidth: svg.parentElement!.clientWidth,
		documentClientWidth: document.documentElement.clientWidth,
		documentScrollWidth: document.documentElement.scrollWidth
	}));
	expect(compact.width).toBeLessThanOrEqual(compact.containerWidth + 1);
	expect(compact.documentScrollWidth - compact.documentClientWidth).toBeLessThanOrEqual(1);
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
