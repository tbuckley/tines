/**
 * State inheritance in the browser (Tines/269): the editor's Inherits-from
 * picker, the pointer lines on a workflow page, and the attribution the issue
 * page puts on an inherited context layer.
 *
 * The fixture is the shape the feature exists for — one base workflow with two
 * children — plus a chain deep enough to make the API refuse. Every workflow
 * is suffixed with `runId`, so a reused server does not collide.
 */
import { expect, test, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, gotoHydrated, runId, signIn } from './helpers';

interface WorkflowBody {
	id: string;
	states: { id: string; name: string; inherits_from: string | null }[];
}

const SHARED = `Shared ${runId}`;
const ENG = `Eng ${runId}`;
const DOCS = `Docs ${runId}`;
const INSTRUCTIONS = `Merge with care — ${runId}.`;

let shared: WorkflowBody;
let eng: WorkflowBody;
let docs: WorkflowBody;
let projectName: string;
let issueNumber: number;

const stateId = (wf: WorkflowBody, name: string) => wf.states.find((s) => s.name === name)!.id;

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({
		baseURL: test.info().project.use.baseURL
	});
	const api = apiClient(request, ALICE.apiKey);

	// The base: no transitions, every state backlog — the convention a
	// base-like workflow is recognised by. Root → Mid → Leaf is the chain the
	// depth refusal needs; Merging is what the two children inherit.
	shared = await body<WorkflowBody>(
		await api.post('/api/v1/workflows', {
			name: SHARED,
			description: 'Shared stages for the inheritance spec.',
			initial_state: 'Merging',
			states: ['Merging', 'Root', 'Mid', 'Leaf'].map((name) => ({ name, category: 'backlog' })),
			transitions: []
		})
	);
	await api.post('/api/v1/context', {
		kind: 'prompt',
		name: 'instructions',
		workflow_state_id: stateId(shared, 'Merging'),
		body: INSTRUCTIONS
	});
	// Mid → Root, Leaf → Mid: a state pointing at Leaf would be the fourth.
	shared = await body<WorkflowBody>(
		await api.patch(`/api/v1/workflows/${shared.id}`, {
			states: [
				{ id: stateId(shared, 'Merging'), name: 'Merging', category: 'backlog' },
				{ id: stateId(shared, 'Root'), name: 'Root', category: 'backlog' },
				{
					id: stateId(shared, 'Mid'),
					name: 'Mid',
					category: 'backlog',
					inherits_from: stateId(shared, 'Root')
				},
				{
					id: stateId(shared, 'Leaf'),
					name: 'Leaf',
					category: 'backlog',
					inherits_from: stateId(shared, 'Mid')
				}
			]
		})
	);

	const child = (name: string) =>
		api.post('/api/v1/workflows', {
			name,
			description: `${name} for the inheritance spec.`,
			initial_state: 'Merging',
			states: [
				{ name: 'Merging', category: 'active', inherits_from: stateId(shared, 'Merging') },
				{ name: 'Review', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				{ name: 'Review it', from: 'Merging', to: 'Review' },
				{ name: 'Finish', from: 'Review', to: 'Done' }
			]
		});
	eng = await body<WorkflowBody>(await child(ENG));
	docs = await body<WorkflowBody>(await child(DOCS));

	projectName = `Inherit ${runId}`;
	const project = await body<{ id: string }>(
		await api.post('/api/v1/projects', {
			name: projectName,
			key: `INH${runId.slice(-4).toUpperCase()}`,
			default_workflow_id: eng.id
		})
	);
	const issue = await body<{ number: number }>(
		await api.post(`/api/v1/projects/${project.id}/issues`, {
			title: `Inherited context ${runId}`,
			description: 'Sits in Eng / Merging, which inherits from Shared / Merging.'
		})
	);
	issueNumber = issue.number;
	await request.dispose();
});

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

/** The row's Inherits-from select: keyed by state id, so rows never collide. */
const picker = (page: Page, id: string) => page.locator(`#state-base-${id}`);

/** What the server says a state's pointer is, read back over the API. */
async function pointerOf(page: Page, workflowId: string, name: string): Promise<string | null> {
	const res = await page.request.get(`/api/v1/workflows/${workflowId}`, {
		headers: { authorization: `Bearer ${ALICE.apiKey}` }
	});
	const wf = await body<WorkflowBody>(res);
	return wf.states.find((s) => s.name === name)!.inherits_from;
}

test('the editor sets, previews and clears a pointer', async ({ page }) => {
	await gotoHydrated(page, `/workflows/${docs.id}`);
	const select = picker(page, stateId(docs, 'Merging'));
	await expect(select).toHaveValue(stateId(shared, 'Merging'));

	// The base's other child, and the base's instructions on demand.
	const row = page.locator('form div.rounded-lg').filter({ has: select });
	await expect(row).toContainText(`also inherited by ${ENG} / Merging`);
	await row.getByRole('button', { name: 'Show inherited instructions' }).click();
	await expect(row).toContainText(INSTRUCTIONS);

	await select.selectOption({ label: 'None' });
	await page.getByRole('button', { name: 'Save workflow' }).click();
	await expect
		.poll(() => pointerOf(page, docs.id, 'Merging'), { message: 'the cleared pointer' })
		.toBe(null);

	await gotoHydrated(page, `/workflows/${docs.id}`);
	await picker(page, stateId(docs, 'Merging')).selectOption(stateId(shared, 'Merging'));
	await page.getByRole('button', { name: 'Save workflow' }).click();
	await expect
		.poll(() => pointerOf(page, docs.id, 'Merging'), { message: 'the restored pointer' })
		.toBe(stateId(shared, 'Merging'));
});

test('the editor previews a saved base in the same workflow', async ({ page }) => {
	await gotoHydrated(page, `/workflows/${shared.id}`);
	const select = picker(page, stateId(shared, 'Root'));
	await select.selectOption(stateId(shared, 'Merging'));
	const row = page.locator('form div.rounded-lg').filter({ has: select });
	await row.getByRole('button', { name: 'Show inherited instructions' }).click();
	await expect(row).toContainText(INSTRUCTIONS);
});

test('a new workflow can choose a base from the loaded library', async ({ page }) => {
	await gotoHydrated(page, '/workflows/new');
	const select = page.getByRole('combobox', { name: 'Inherits from' }).first();
	await select.selectOption(stateId(shared, 'Merging'));
	await expect(select).toHaveValue(stateId(shared, 'Merging'));
	await expect(page.locator('form')).toContainText(`Inherits context from ${SHARED} / Merging`);
});

test('a cycle and an over-deep chain are refused with the API’s own message', async ({ page }) => {
	// Docs / Merging already inherits from Shared / Merging, so pointing the
	// base back at its own child closes the loop.
	await gotoHydrated(page, `/workflows/${shared.id}`);
	await picker(page, stateId(shared, 'Merging')).selectOption(stateId(docs, 'Merging'));
	await page.getByRole('button', { name: 'Save workflow' }).click();
	await expect(page.locator('form')).toContainText(/loop/i);
	expect(await pointerOf(page, shared.id, 'Merging')).toBe(null);

	// Root → Mid → Leaf is already three; a fourth is over the limit.
	await gotoHydrated(page, `/workflows/${docs.id}`);
	await picker(page, stateId(docs, 'Review')).selectOption(stateId(shared, 'Leaf'));
	await page.getByRole('button', { name: 'Save workflow' }).click();
	await expect(page.locator('form')).toContainText(/at most 3|limit is 3|3 states/i);
	expect(await pointerOf(page, docs.id, 'Review')).toBe(null);
});

test('saving without touching the picker leaves every pointer alone', async ({ page }) => {
	await gotoHydrated(page, `/workflows/${eng.id}`);
	const patch = page.waitForRequest(
		(r) => r.method() === 'PATCH' && r.url().includes(`/api/v1/workflows/${eng.id}`)
	);
	await page.getByRole('button', { name: 'Save workflow' }).click();
	const sent = (await patch).postDataJSON() as { states: Record<string, unknown>[] };
	// Merge-patch is what makes an untouched round trip safe: the key is absent.
	for (const state of sent.states) expect(state).not.toHaveProperty('inherits_from');
	await expect.poll(() => pointerOf(page, eng.id, 'Merging')).toBe(stateId(shared, 'Merging'));
});

test('the workflow page names both directions of a pointer', async ({ page }) => {
	await page.goto(`/workflows/${shared.id}`);
	const base = page.locator(`#state-${stateId(shared, 'Merging')}`);
	await expect(base).toContainText(`${ENG} / Merging`);
	await expect(base).toContainText(`${DOCS} / Merging`);

	await gotoHydrated(page, `/workflows/${eng.id}`);
	// The accordion header is a button, so its pointer line is text; the
	// editor row above it carries the link to the base.
	await expect(page.locator(`#state-${stateId(eng, 'Merging')}`)).toContainText(
		`inherits from ${SHARED} / Merging`
	);
	const child = page.locator(`#state-${stateId(eng, 'Merging')}`);
	await child.getByRole('button').first().click();
	await expect(child).toContainText(INSTRUCTIONS);
	const via = child.getByRole('link', { name: `via ${SHARED} / Merging` });
	await expect(via).toBeVisible();

	// At phone width the chips wrap below the name instead of crushing it to a glyph.
	await page.setViewportSize({ width: 390, height: 844 });
	const itemName = child.getByText('instructions', { exact: true });
	await expect(itemName).toBeVisible();
	expect((await itemName.boundingBox())!.width).toBeGreaterThan(80);
	await via.click();
	await expect(page).toHaveURL(
		new RegExp(`/workflows/${shared.id}#state-${stateId(shared, 'Merging')}$`)
	);
	await expect(
		page
			.locator(`#state-${stateId(shared, 'Merging')}`)
			.getByRole('button')
			.first()
	).toHaveAttribute('aria-expanded', 'true');
});

test('the issue page attributes an inherited layer to its base', async ({ page }) => {
	await gotoHydrated(page, `/issues/${encodeURIComponent(projectName)}/${issueNumber}`);
	await page.getByText('Effective context').first().click();
	const via = page.getByText(`via ${SHARED} / Merging`).first();
	await expect(via).toBeVisible();
	await expect(page.getByText(`also inherited by`).first()).toContainText(`${DOCS} / Merging`);
});

test('removing a base offers to clear the pointers that name it', async ({ page }) => {
	// Last: this unmakes the fixture's inheritance graph.
	await gotoHydrated(page, `/workflows/${shared.id}`);
	const row = page
		.locator('form div.rounded-lg')
		.filter({ has: picker(page, stateId(shared, 'Merging')) });
	await row.getByRole('button', { name: 'Remove state' }).click();
	await page.getByRole('button', { name: 'Save workflow' }).click();

	// The base holds the instructions item, so consent for the sweep is asked
	// before consent for the pointers — both guards fire on this one save.
	const sweep = page.getByRole('alertdialog', { name: 'Delete attached context too?' });
	await expect(sweep).toContainText('instructions');
	await sweep.getByRole('button', { name: 'Delete them' }).click();

	const dialog = page.getByRole('alertdialog', { name: 'Clear inheritance pointers too?' });
	await expect(dialog).toContainText(`${ENG} / Merging`);
	await expect(dialog).toContainText(`${DOCS} / Merging`);
	await dialog.getByRole('button', { name: 'Clear and continue' }).click();

	await expect.poll(() => pointerOf(page, eng.id, 'Merging')).toBe(null);
	expect(await pointerOf(page, docs.id, 'Merging')).toBe(null);
});
