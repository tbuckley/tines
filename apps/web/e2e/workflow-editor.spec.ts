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
let wideWorkflowName: string;
let reorderWorkflowName: string;
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
let reorderWorkflowId: string;
let reorderStateIds: Record<string, string>;

const stateOrder = (page: Page) =>
	page
		.locator('[data-state-row]')
		.evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.stateName));

const stateRow = (page: Page, name: string) =>
	page
		.getByRole('button', { name: new RegExp(`^Move ${name} (up|down)$`) })
		.first()
		.locator('xpath=ancestor::*[@data-state-row]');

async function expandState(page: Page, name: string) {
	const row = stateRow(page, name);
	const trigger = row.getByRole('button', { name: `Edit ${name} state`, exact: true });
	if (await trigger.count()) await trigger.click();
	return row;
}

type TransitionPhase = {
	startedAt: number | null;
	endedAt: number | null;
	durations: number[];
};

type StateTransitionMotion = {
	intro: TransitionPhase;
	outro: TransitionPhase;
};

async function observeStateTransition(page: Page, name: string): Promise<void> {
	await page.evaluate((stateName) => {
		const motion: StateTransitionMotion = {
			intro: { startedAt: null, endedAt: null, durations: [] },
			outro: { startedAt: null, endedAt: null, durations: [] }
		};
		(window as unknown as { stateTransitionMotion: StateTransitionMotion }).stateTransitionMotion =
			motion;

		const matches = (event: Event): event is CustomEvent & { target: Element } =>
			event.target instanceof Element &&
			event.target.matches(`[role="region"][aria-label="Edit ${CSS.escape(stateName)} state"]`);
		const start = (phase: TransitionPhase, event: Event) => {
			if (!matches(event)) return;
			phase.startedAt = performance.now();
			const target = event.target;
			requestAnimationFrame(() => {
				phase.durations = target.getAnimations().flatMap((animation) => {
					const duration = animation.effect?.getTiming().duration;
					return typeof duration === 'number' ? [duration] : [];
				});
			});
		};
		const end = (phase: TransitionPhase, event: Event) => {
			if (matches(event)) phase.endedAt = performance.now();
		};

		document.addEventListener('introstart', (event) => start(motion.intro, event), true);
		document.addEventListener('introend', (event) => end(motion.intro, event), true);
		document.addEventListener('outrostart', (event) => start(motion.outro, event), true);
		document.addEventListener('outroend', (event) => end(motion.outro, event), true);
	}, name);
}

const stateTransitionMotion = (page: Page) =>
	page.evaluate(
		() =>
			(window as unknown as { stateTransitionMotion: StateTransitionMotion }).stateTransitionMotion
	);

async function moveWithAnimationProbe(page: Page, name: string, direction: 'up' | 'down') {
	return page.evaluate(
		async ({ stateName, moveDirection }) => {
			const findRow = () =>
				[...document.querySelectorAll<HTMLElement>('[data-state-row]')].find(
					(row) => row.dataset.stateName === stateName
				);
			const row = findRow();
			if (!row) throw new Error(`No state row named ${stateName}`);
			const button = row.querySelector<HTMLButtonElement>(
				`button[data-move-direction="${moveDirection}"]`
			);
			if (!button) throw new Error(`No ${moveDirection} button for ${stateName}`);

			const before = row.getBoundingClientRect().top;
			const positions = [before];
			let duration = 0;
			let sawAnimation = false;
			let idleFrames = 0;
			button.click();

			for (let frame = 0; frame < 90; frame += 1) {
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				const movedRow = findRow();
				if (!movedRow) throw new Error(`State row ${stateName} disappeared`);
				positions.push(movedRow.getBoundingClientRect().top);
				const animations = movedRow.getAnimations();
				for (const animation of animations) {
					const animationDuration = animation.effect?.getTiming().duration;
					if (typeof animationDuration === 'number')
						duration = Math.max(duration, animationDuration);
				}
				if (animations.some((animation) => ['pending', 'running'].includes(animation.playState))) {
					sawAnimation = true;
					idleFrames = 0;
				} else {
					idleFrames += 1;
				}
				if ((sawAnimation && idleFrames >= 2) || (!sawAnimation && idleFrames >= 3)) break;
			}

			return {
				before,
				duration,
				positions,
				final: findRow()!.getBoundingClientRect().top,
				order: [...document.querySelectorAll<HTMLElement>('[data-state-row]')].map(
					(candidate) => candidate.dataset.stateName
				)
			};
		},
		{ stateName: name, moveDirection: direction }
	);
}

const previewGeometry = async (page: Page) => {
	const region = page.getByRole('region', { name: 'Live preview' });
	return region.evaluate((regionEl) => {
		const svg = regionEl.querySelector('svg')!;
		const heading = document.getElementById(regionEl.getAttribute('aria-labelledby')!)!;
		const viewBoxWidth = svg.viewBox.baseVal.width;
		const svgBounds = svg.getBoundingClientRect();
		const regionBounds = regionEl.getBoundingClientRect();
		return {
			svgRatio: svg.getBoundingClientRect().width / viewBoxWidth,
			svgLeft: svgBounds.left,
			svgRight: svgBounds.right,
			regionLeft: regionBounds.left,
			regionRight: regionBounds.right,
			regionClientWidth: regionEl.clientWidth,
			regionScrollWidth: regionEl.scrollWidth,
			regionScrollLeft: regionEl.scrollLeft,
			headingLeft: heading.getBoundingClientRect().left,
			documentClientWidth: document.documentElement.clientWidth,
			documentScrollWidth: document.documentElement.scrollWidth
		};
	});
};

async function previewFadedEdges(page: Page) {
	const mask = await page
		.getByRole('region', { name: 'Live preview' })
		.evaluate((el) => getComputedStyle(el).maskImage);
	if (mask === 'none') return { masked: false, left: false, right: false };
	return {
		masked: true,
		left: /\(to right, rgba\(0, 0, 0, 0\) 0px/.test(mask),
		right: /rgba\(0, 0, 0, 0\) 100%\)$/.test(mask)
	};
}

const expectPreviewFade = (page: Page, edges: { left: boolean; right: boolean }) =>
	expect.poll(() => previewFadedEdges(page)).toEqual({ masked: true, ...edges });

async function renderedGraphText(page: Page) {
	return page.getByRole('region', { name: 'Live preview' }).evaluate(async (region) => {
		await document.fonts.ready;
		const svg = region.querySelector('svg')!;
		const viewBox = svg.viewBox.baseVal;
		const box = (element: SVGGraphicsElement, padding = 0) => {
			const value = element.getBBox();
			return {
				x: value.x - padding,
				y: value.y - padding,
				w: value.width + padding * 2,
				h: value.height + padding * 2
			};
		};
		const intersects = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
			Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.01 &&
			Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.01;
		const stateBodies = [...svg.querySelectorAll<SVGRectElement>('[data-graph-state]')].map(
			(element) => ({ id: element.dataset.graphState!, box: box(element) })
		);
		const stateLabels = [...svg.querySelectorAll<SVGTextElement>('[data-graph-state-label]')].map(
			(element) => ({
				id: element.dataset.graphStateLabel!,
				text: element.textContent,
				box: box(element, 0.5)
			})
		);
		const actionLabels = [
			...svg.querySelectorAll<SVGTextElement>('[data-graph-transition-label]')
		].map((element) => box(element, 1.5));
		const actionStateIntersections = actionLabels.flatMap((label, labelIndex) =>
			stateBodies.flatMap((state) =>
				intersects(label, state.box) ? [`${labelIndex}:${state.id}`] : []
			)
		);
		const actionActionIntersections: string[] = [];
		for (let index = 0; index < actionLabels.length; index += 1) {
			for (let other = index + 1; other < actionLabels.length; other += 1) {
				if (intersects(actionLabels[index], actionLabels[other]))
					actionActionIntersections.push(`${index}:${other}`);
			}
		}
		const stateTextOutsideBody = stateLabels.flatMap((label) => {
			const body = stateBodies.find((candidate) => candidate.id === label.id)?.box;
			if (
				!body ||
				label.box.x < body.x - 0.01 ||
				label.box.y < body.y - 0.01 ||
				label.box.x + label.box.w > body.x + body.w + 0.01 ||
				label.box.y + label.box.h > body.y + body.h + 0.01
			)
				return [{ id: label.id, text: label.text, label: label.box, body }];
			return [];
		});
		const textOutsideViewBox = [...actionLabels, ...stateLabels.map(({ box }) => box)].filter(
			(value) =>
				value.x < viewBox.x - 0.01 ||
				value.y < viewBox.y - 0.01 ||
				value.x + value.w > viewBox.x + viewBox.width + 0.01 ||
				value.y + value.h > viewBox.y + viewBox.height + 0.01
		).length;
		return {
			actionStateIntersections,
			actionActionIntersections,
			stateTextOutsideBody,
			textOutsideViewBox
		};
	});
}

test.beforeAll(async ({ apiFor, uniqueName }) => {
	workflowName = uniqueName('Header', { maxLength: 32 });
	wideWorkflowName = uniqueName('Wide preview', { maxLength: 100 });
	reorderWorkflowName = uniqueName('Reorder states', { maxLength: 100 });
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

	const reorder = await body<{
		id: string;
		states: { id: string; name: string }[];
	}>(
		await api.post('/api/v1/workflows', {
			name: reorderWorkflowName,
			description: 'A workflow used to verify persisted state ordering.',
			initial_state: 'Open',
			states: [
				{ name: 'Open', category: 'active' },
				{ name: 'Review', category: 'awaiting_human' },
				{ name: 'Closed', category: 'done' }
			],
			transitions: [
				{ name: 'Submit', from: 'Open', to: 'Review' },
				{
					name: 'Approve',
					from: 'Review',
					to: 'Closed',
					requires: [
						{
							artifact: 'approval',
							type: 'text',
							content_type: 'text/markdown',
							description: 'The approval record'
						}
					]
				}
			]
		})
	);
	reorderWorkflowId = reorder.id;
	reorderStateIds = Object.fromEntries(reorder.states.map((state) => [state.name, state.id]));
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

test('state rows summarize the workflow and expand one inline editor at a time', async ({
	page
}) => {
	await gotoHydrated(page, `/workflows/${reorderWorkflowId}`);
	await expect(page.getByLabel('State name', { exact: true })).toHaveCount(0);
	const review = stateRow(page, 'Review');
	await expect(review.getByText('Approve → Closed', { exact: true })).toBeVisible();
	await expect(review.getByText('approval · 1 required artifact', { exact: true })).toBeVisible();

	const reviewTrigger = review.getByRole('button', { name: 'Edit Review state', exact: true });
	await reviewTrigger.click();
	await expect(review.getByRole('region', { name: 'Edit Review state' })).toBeVisible();
	await expect(review.getByLabel('State name')).toBeFocused();
	await expect(review.getByRole('button', { name: 'Collapse Review state' })).toHaveAttribute(
		'aria-expanded',
		'true'
	);

	await stateRow(page, 'Open').getByRole('button', { name: 'Edit Open state' }).click();
	await expect(review.getByRole('region', { name: 'Edit Review state' })).toHaveCount(0);
	const open = stateRow(page, 'Open');
	await open.getByRole('button', { name: 'Collapse Open', exact: true }).click();
	await expect(open.getByRole('button', { name: 'Edit Open state' })).toBeFocused();
});

test('state expansion, collapse, and reordering visibly animate when motion is enabled', async ({
	page
}) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await gotoHydrated(page, `/workflows/${reorderWorkflowId}`);
	await observeStateTransition(page, 'Open');

	const open = stateRow(page, 'Open');
	await open.getByRole('button', { name: 'Edit Open state' }).click();
	await page.waitForFunction(
		() =>
			(window as unknown as { stateTransitionMotion: StateTransitionMotion }).stateTransitionMotion
				.intro.endedAt !== null
	);
	await open.getByRole('button', { name: 'Collapse Open state' }).click();
	await page.waitForFunction(
		() =>
			(window as unknown as { stateTransitionMotion: StateTransitionMotion }).stateTransitionMotion
				.outro.endedAt !== null
	);

	const motion = await stateTransitionMotion(page);
	expect(Math.max(0, ...motion.intro.durations)).toBeGreaterThanOrEqual(350);
	expect(motion.intro.endedAt! - motion.intro.startedAt!).toBeGreaterThanOrEqual(300);
	expect(Math.max(0, ...motion.outro.durations)).toBeGreaterThanOrEqual(230);
	expect(motion.outro.endedAt! - motion.outro.startedAt!).toBeGreaterThanOrEqual(180);

	const move = await moveWithAnimationProbe(page, 'Review', 'up');
	expect(move.order).toEqual(['Review', 'Open', 'Closed']);
	expect(move.duration).toBeGreaterThanOrEqual(400);
	expect(move.final).toBeLessThan(move.before);
	const lower = Math.min(move.before, move.final) + 1;
	const upper = Math.max(move.before, move.final) - 1;
	expect(move.positions.some((position) => position > lower && position < upper)).toBe(true);
});

test('reduced motion makes state expansion, collapse, and reordering immediate', async ({
	page
}) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await gotoHydrated(page, `/workflows/${reorderWorkflowId}`);
	await observeStateTransition(page, 'Open');

	const open = stateRow(page, 'Open');
	await open.getByRole('button', { name: 'Edit Open state' }).click();
	await expect(open.getByRole('region', { name: 'Edit Open state' })).toBeVisible();
	await open.getByRole('button', { name: 'Collapse Open state' }).click();
	await expect(open.getByRole('region', { name: 'Edit Open state' })).toHaveCount(0);

	const motion = await stateTransitionMotion(page);
	expect(Math.max(0, ...motion.intro.durations)).toBe(0);
	expect(motion.intro.endedAt! - motion.intro.startedAt!).toBeLessThan(50);
	expect(Math.max(0, ...motion.outro.durations)).toBe(0);
	expect(motion.outro.endedAt! - motion.outro.startedAt!).toBeLessThan(50);

	const move = await moveWithAnimationProbe(page, 'Review', 'up');
	expect(move.order).toEqual(['Review', 'Open', 'Closed']);
	expect(move.duration).toBe(0);
	for (const position of move.positions.slice(1)) expect(position).toBeCloseTo(move.final, 1);
});

test('an editable workflow can save parallel named actions to one state', async ({ page }) => {
	await gotoHydrated(page, `/workflows/${workflowId}`);
	await expandState(page, 'Open');
	await expect(page.getByLabel('Action name')).toHaveCount(2);
	await expect(page.getByText('Only one action can lead')).toHaveCount(0);
	const save = page.getByRole('button', { name: 'Save workflow' });
	await expect(save).toBeEnabled();
	await page.getByRole('button', { name: '1×', exact: true }).click();
	await expect(page.getByRole('button', { name: '1×', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	const response = page.waitForResponse(
		(res) =>
			res.request().method() === 'PATCH' && res.url().endsWith(`/api/v1/workflows/${workflowId}`)
	);
	await save.click();
	expect((await response).ok()).toBe(true);
	await expandState(page, 'Open');
	await expect(page.getByLabel('Action name')).toHaveCount(2);
	await expect(page.getByRole('button', { name: 'Fit', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
});

test('state moves preserve references and persist the displayed order through reload', async ({
	page
}) => {
	await gotoHydrated(page, `/workflows/${reorderWorkflowId}`);
	expect(await stateOrder(page)).toEqual(['Open', 'Review', 'Closed']);
	await expect(page.getByRole('button', { name: 'Move Open up' })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Move Closed down' })).toBeDisabled();
	const openRow = await expandState(page, 'Open');
	await expect(openRow.getByRole('radio')).toBeChecked();
	await expect(openRow.getByLabel('Target state')).toHaveValue(reorderStateIds.Review);
	const reviewRow = await expandState(page, 'Review');
	await expect(reviewRow.getByLabel('Target state')).toHaveValue(reorderStateIds.Closed);
	await expect(reviewRow.getByLabel('Required artifact name')).toHaveValue('approval');

	const reviewUp = page.getByRole('button', { name: 'Move Review up' });
	await reviewUp.focus();
	await page.keyboard.press('Space');
	expect(await stateOrder(page)).toEqual(['Review', 'Open', 'Closed']);
	await expect(page.getByRole('status')).toHaveText('Review moved to position 1 of 3.');
	await expect(page.getByRole('button', { name: 'Move Review down' })).toBeFocused();

	await page.getByRole('button', { name: 'Move Review down' }).click();
	expect(await stateOrder(page)).toEqual(['Open', 'Review', 'Closed']);
	await expect(page.getByRole('button', { name: 'Move Review down' })).toBeFocused();
	await page.getByRole('button', { name: 'Move Closed up' }).click();
	expect(await stateOrder(page)).toEqual(['Open', 'Closed', 'Review']);
	await expect(page.getByRole('button', { name: 'Move Closed up' })).toBeFocused();

	const closedRow = await expandState(page, 'Closed');
	await closedRow.getByLabel('State name').fill('Archived');
	const reopenedOpen = await expandState(page, 'Open');
	await expect(reopenedOpen.getByRole('radio')).toBeChecked();
	await expect(reopenedOpen.getByLabel('Target state')).toHaveValue(reorderStateIds.Review);
	await expect((await expandState(page, 'Review')).getByLabel('Target state')).toHaveValue(
		reorderStateIds.Closed
	);

	const responsePromise = page.waitForResponse(
		(response) =>
			response.request().method() === 'PATCH' &&
			response.url().endsWith(`/api/v1/workflows/${reorderWorkflowId}`)
	);
	await page.getByRole('button', { name: 'Save workflow' }).click();
	const response = await responsePromise;
	expect(response.ok()).toBe(true);
	const request = response.request().postDataJSON();
	expect(request.states.map((state: { id: string }) => state.id)).toEqual([
		reorderStateIds.Open,
		reorderStateIds.Closed,
		reorderStateIds.Review
	]);
	expect(request.initial_state).toBe(reorderStateIds.Open);
	expect(request.transitions).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: 'Submit',
				from: reorderStateIds.Open,
				to: reorderStateIds.Review
			}),
			expect.objectContaining({
				name: 'Approve',
				from: reorderStateIds.Review,
				to: reorderStateIds.Closed,
				requires: [
					{
						artifact: 'approval',
						type: 'text',
						content_type: 'text/markdown',
						description: 'The approval record'
					}
				]
			})
		])
	);
	const saved = (await response.json()) as {
		states: { id: string; position: number }[];
	};
	expect(saved.states.map(({ id, position }) => ({ id, position }))).toEqual([
		{ id: reorderStateIds.Open, position: 0 },
		{ id: reorderStateIds.Closed, position: 1 },
		{ id: reorderStateIds.Review, position: 2 }
	]);
	await expect.poll(() => stateOrder(page)).toEqual(['Open', 'Archived', 'Review']);
	await page.reload();
	await expect(page.getByRole('heading', { level: 1, name: reorderWorkflowName })).toBeVisible();
	expect(await stateOrder(page)).toEqual(['Open', 'Archived', 'Review']);
	const reloadedOpen = await expandState(page, 'Open');
	await expect(reloadedOpen.getByRole('radio')).toBeChecked();
	await expect(reloadedOpen.getByLabel('Target state')).toHaveValue(reorderStateIds.Review);
});

test('a rejected save keeps the reordered draft available for retry', async ({ page }) => {
	await gotoHydrated(page, `/workflows/${reorderWorkflowId}`);
	await page.getByRole('button', { name: 'Move Review up' }).click();
	expect(await stateOrder(page)).toEqual(['Open', 'Review', 'Archived']);
	await page.route(`**/api/v1/workflows/${reorderWorkflowId}`, async (route) => {
		if (route.request().method() !== 'PATCH') return route.continue();
		await route.fulfill({
			status: 500,
			contentType: 'application/json',
			body: JSON.stringify({ error: { code: 'forced_failure', message: 'Forced save failure' } })
		});
	});
	await page.getByRole('button', { name: 'Save workflow' }).click();
	await expect(page.getByText('Forced save failure', { exact: true })).toBeVisible();
	expect(await stateOrder(page)).toEqual(['Open', 'Review', 'Archived']);
});

test('new-state moves preserve draft prompts and resolve references on create', async ({
	page,
	uniqueName
}) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await gotoHydrated(page, '/workflows/new');
	const name = uniqueName('New reordered workflow', { maxLength: 100 });
	await page.getByLabel('Name', { exact: true }).fill(name);
	await page.getByRole('button', { name: 'Add state' }).click();
	await page.getByLabel('State name', { exact: true }).last().fill('Review');
	const review = stateRow(page, 'Review');
	await review.getByRole('radio').check();
	await review.getByRole('button', { name: 'Add stage instructions' }).click();
	await review.locator('textarea').fill('Check the implementation carefully.');
	await (
		await expandState(page, 'Open')
	)
		.getByLabel('Target state')
		.selectOption({ label: 'Review' });
	await page.getByRole('button', { name: 'Move Review up' }).click();
	await page.getByRole('button', { name: 'Move Review up' }).click();
	expect(await stateOrder(page)).toEqual(['Review', 'Open', 'Done']);
	await expect(page.getByRole('button', { name: 'Move Review down' })).toBeFocused();

	const requestPromise = page.waitForRequest(
		(request) => request.method() === 'POST' && request.url().endsWith('/api/v1/workflows')
	);
	await page.getByRole('button', { name: 'Create workflow' }).click();
	const request = (await requestPromise).postDataJSON();
	expect(request.states.map((state: { name: string }) => state.name)).toEqual([
		'Review',
		'Open',
		'Done'
	]);
	expect(request.states[0].prompt).toBe('Check the implementation carefully.');
	expect(request.initial_state).toBe('Review');
	expect(request.transitions[0]).toMatchObject({ from: 'Open', to: 'Review' });
	await expect(page).toHaveURL(/\/workflows\/wf_/);
});

test('move controls stay contained and show both boundaries for one state on a phone', async ({
	page
}) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await gotoHydrated(page, '/workflows/new');
	await expandState(page, 'Done');
	await page.getByRole('button', { name: 'Remove state' }).click();
	await expect(page.getByRole('button', { name: 'Move Open up' })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Move Open down' })).toBeDisabled();
	const geometry = await page.locator('form').evaluate((form) => ({
		formRight: form.getBoundingClientRect().right,
		documentWidth: document.documentElement.scrollWidth,
		viewportWidth: document.documentElement.clientWidth
	}));
	expect(geometry.formRight).toBeLessThanOrEqual(375);
	expect(geometry.documentWidth - geometry.viewportWidth).toBeLessThanOrEqual(1);
});

test('the preview keeps a transition path keyed across action rename and reorder', async ({
	page
}) => {
	await gotoHydrated(page, `/workflows/${workflowId}`);
	await expandState(page, 'Open');
	const preview = page.getByRole('region', { name: 'Live preview' });
	const abandonLabel = preview.getByText('Abandon', { exact: true });
	const transitionKey = await abandonLabel.getAttribute('data-graph-transition-label');
	const tracked = await preview
		.locator(`path[data-graph-transition=${JSON.stringify(transitionKey)}]`)
		.elementHandle();
	expect(tracked).not.toBeNull();

	await page.getByLabel('Action name').nth(1).fill('Escalate');
	await page.getByRole('button', { name: 'Remove action from Open' }).first().click();
	await expect(page.getByLabel('Action name')).toHaveCount(1);
	await expect(page.getByLabel('Action name')).toHaveValue('Escalate');
	await expect(preview.getByText('Escalate', { exact: true })).toBeVisible();
	expect(await tracked!.evaluate((path) => path.isConnected)).toBe(true);
	expect(await tracked!.getAttribute('data-graph-transition')).toBe(transitionKey);
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
	// two-fifths, after the retained Publish and Export actions, so the form is
	// still what the page opens on.
	const nameTop = await page
		.getByLabel('Name', { exact: true })
		.evaluate((el) => el.getBoundingClientRect().top);
	expect(nameTop).toBeLessThan(844 * 0.4);
});

test('a wide live preview defaults to Fit and round-trips through exact 1×', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await gotoHydrated(page, `/workflows/${wideWorkflowId}`);

	const region = page.getByRole('region', { name: 'Live preview' });
	const fit = page.getByRole('button', { name: 'Fit', exact: true });
	const actual = page.getByRole('button', { name: '1×', exact: true });
	await expect(region.getByText('Return 7 to 6', { exact: true })).toBeAttached();
	await expect(fit).toHaveAttribute('aria-pressed', 'true');
	await expect(actual).toHaveAttribute('aria-pressed', 'false');
	const fitted = await previewGeometry(page);
	expect(fitted.svgRatio).toBeLessThan(1);
	expect(fitted.regionScrollWidth - fitted.regionClientWidth).toBeLessThanOrEqual(1);
	expect(fitted.svgLeft).toBeGreaterThanOrEqual(fitted.regionLeft - 1);
	expect(fitted.svgRight).toBeLessThanOrEqual(fitted.regionRight + 1);
	expect(fitted.documentScrollWidth - fitted.documentClientWidth).toBeLessThanOrEqual(1);
	await expect
		.poll(() => previewFadedEdges(page))
		.toEqual({
			masked: false,
			left: false,
			right: false
		});

	await actual.focus();
	await page.keyboard.press('Enter');
	await expect(actual).toBeFocused();
	await expect(actual).toHaveAttribute('aria-pressed', 'true');
	let intrinsic = await previewGeometry(page);
	expect(intrinsic.svgRatio).toBeCloseTo(1, 2);
	expect(intrinsic.regionScrollWidth).toBeGreaterThan(intrinsic.regionClientWidth);
	expect(intrinsic.regionScrollLeft).toBe(0);
	expect(intrinsic.documentScrollWidth - intrinsic.documentClientWidth).toBeLessThanOrEqual(1);
	await expectPreviewFade(page, { left: false, right: true });

	await region.focus();
	await expect(region).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect.poll(async () => (await previewGeometry(page)).regionScrollLeft).toBeGreaterThan(0);
	await expectPreviewFade(page, { left: true, right: true });
	expect((await previewGeometry(page)).headingLeft).toBeCloseTo(fitted.headingLeft, 1);

	const renamedAction = 'Advance with a substantially longer action label';
	await expandState(page, 'Engineering state 1');
	await page.getByLabel('Action name').first().fill(renamedAction);
	await expect(region.getByText(renamedAction, { exact: true })).toBeVisible();
	const afterEdit = await previewGeometry(page);
	expect(afterEdit.svgRatio).toBeCloseTo(1, 2);
	expect(afterEdit.regionScrollWidth).toBeGreaterThan(afterEdit.regionClientWidth);
	expect(afterEdit.documentScrollWidth - afterEdit.documentClientWidth).toBeLessThanOrEqual(1);

	await fit.focus();
	await page.keyboard.press('Space');
	await expect(fit).toBeFocused();
	await expect(fit).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(async () => (await previewGeometry(page)).regionScrollLeft).toBe(0);
	const refitted = await previewGeometry(page);
	expect(refitted.svgRatio).toBeLessThan(1);
	expect(refitted.svgLeft).toBeGreaterThanOrEqual(refitted.regionLeft - 1);
	expect(refitted.svgRight).toBeLessThanOrEqual(refitted.regionRight + 1);
	await expect
		.poll(() => previewFadedEdges(page))
		.toEqual({
			masked: false,
			left: false,
			right: false
		});

	await actual.click();
	intrinsic = await previewGeometry(page);
	expect(intrinsic.svgRatio).toBeCloseTo(1, 2);
	expect(intrinsic.regionScrollLeft).toBe(0);
	await expectPreviewFade(page, { left: false, right: true });
});

test('browser text bounds stay inside reserved boxes without collisions', async ({ page }) => {
	await gotoHydrated(page, `/workflows/${wideWorkflowId}`);
	const firstName = `${'W'.repeat(45)} <script>`;
	await (await expandState(page, 'Engineering state 1')).getByLabel('State name').fill(firstName);
	await (
		await expandState(page, 'Engineering state 2')
	)
		.getByLabel('State name')
		.fill(`境界テスト ${'界'.repeat(20)} 👩‍💻 e\u0301`);
	await (
		await expandState(page, firstName)
	)
		.getByLabel('Action name')
		.first()
		.fill(`Route ${'W'.repeat(38)} 界 😀 <b>literal</b>`);
	await expect(page.getByRole('region', { name: 'Live preview' }).locator('svg')).toBeVisible();
	expect(await renderedGraphText(page)).toEqual({
		actionStateIntersections: [],
		actionActionIntersections: [],
		stateTextOutsideBody: [],
		textOutsideViewBox: 0
	});
});

test('a wide live preview toggles and remains contained on a phone', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await gotoHydrated(page, `/workflows/${wideWorkflowId}`);

	const region = page.getByRole('region', { name: 'Live preview' });
	const group = page.getByRole('group', { name: 'Preview zoom' });
	await region.scrollIntoViewIfNeeded();
	const before = await previewGeometry(page);
	expect(before.svgRatio).toBeLessThan(1);
	expect(before.regionScrollWidth - before.regionClientWidth).toBeLessThanOrEqual(1);
	expect(before.documentScrollWidth - before.documentClientWidth).toBeLessThanOrEqual(1);
	const groupBounds = await group.boundingBox();
	expect(groupBounds!.x).toBeGreaterThanOrEqual(0);
	expect(groupBounds!.x + groupBounds!.width).toBeLessThanOrEqual(390);

	await group.getByRole('button', { name: '1×', exact: true }).click();
	await expect.poll(async () => (await previewGeometry(page)).svgRatio).toBeCloseTo(1, 2);
	expect((await previewGeometry(page)).regionScrollWidth).toBeGreaterThan(before.regionClientWidth);
	await expectPreviewFade(page, { left: false, right: true });
	await region.evaluate((el) => {
		el.scrollTo({ left: el.scrollWidth, behavior: 'instant' });
	});
	await expect.poll(async () => (await previewGeometry(page)).regionScrollLeft).toBeGreaterThan(0);
	await expectPreviewFade(page, { left: true, right: false });
	await page.setViewportSize({ width: 440, height: 844 });
	await expect(group.getByRole('button', { name: '1×', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	expect((await previewGeometry(page)).svgRatio).toBeCloseTo(1, 2);
	await group.getByRole('button', { name: 'Fit', exact: true }).click();
	const refitted = await previewGeometry(page);
	expect(refitted.documentScrollWidth - refitted.documentClientWidth).toBeLessThanOrEqual(1);
});

test('a small new workflow has fresh Fit state and exact 1× without submitting', async ({
	page
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const writes: string[] = [];
	page.on('request', (request) => {
		if (['POST', 'PATCH'].includes(request.method())) writes.push(request.method());
	});
	await gotoHydrated(page, '/workflows/new');
	const name = page.getByLabel('Name', { exact: true });
	await name.fill('Unsaved zoom choice');
	const fitted = await previewGeometry(page);
	expect(fitted.svgRatio).toBeGreaterThan(1);
	await page.getByRole('button', { name: '1×', exact: true }).click();
	expect((await previewGeometry(page)).svgRatio).toBeCloseTo(1, 2);
	await expect(name).toHaveValue('Unsaved zoom choice');
	expect(writes).toEqual([]);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Fit', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
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
	const targetHeading = page.getByRole('heading', {
		level: 2,
		name: wideWorkflowName,
		includeHidden: true
	});
	const targetDetails = targetHeading.locator('xpath=ancestor::details');
	if ((await targetDetails.count()) > 0)
		await targetDetails.evaluate((details) => ((details as HTMLDetailsElement).open = true));
	const card = page
		.getByRole('heading', { level: 2, name: wideWorkflowName })
		.locator('xpath=ancestor::a');
	const compact = await card.getByRole('img', { name: 'Workflow graph' }).evaluate((svg) => ({
		width: svg.getBoundingClientRect().width,
		containerWidth: svg.parentElement!.clientWidth,
		documentClientWidth: document.documentElement.clientWidth,
		documentScrollWidth: document.documentElement.scrollWidth,
		left: svg.getBoundingClientRect().left,
		right: svg.getBoundingClientRect().right
	}));
	expect(compact.width).toBeLessThanOrEqual(compact.containerWidth + 1);
	expect(compact.documentScrollWidth - compact.documentClientWidth).toBeLessThanOrEqual(1);
	expect(compact.left).toBeGreaterThanOrEqual(-1);
	expect(compact.right).toBeLessThanOrEqual(compact.documentClientWidth + 1);
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
