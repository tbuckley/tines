import type { IssueDetail, Project, RunnerTokenResponse, WorkflowResponse } from '@tines/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import {
	apiClient,
	body,
	DESKTOP,
	gotoHydrated,
	PHONE,
	readSettled,
	runId,
	signIn
} from './helpers';

const projectName = `pin-layout-${runId}`;
const runnerName = `runner-name-that-stays-inside-the-full-width-control-${runId}`;
let project: Project;
let runner: RunnerTokenResponse['runner'];
let issues: IssueDetail[];

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({
		baseURL: test.info().project.use.baseURL
	});
	const api = apiClient(request, ALICE.apiKey);
	project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
	runner = (
		await body<RunnerTokenResponse>(
			await api.post('/api/v1/runners/register', {
				name: runnerName,
				harness: 'custom',
				command: 'true'
			})
		)
	).runner;
	const workflow = await body<WorkflowResponse>(
		await api.post('/api/v1/workflows', {
			name: `Pin layout ${runId}`,
			initial_state: 'Backlog',
			states: [
				{ name: 'Backlog', category: 'backlog' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [{ name: 'Finish', from: 'Backlog', to: 'Done' }]
		})
	);
	issues = await Promise.all(
		Array.from({ length: 5 }, async (_, index) =>
			body<IssueDetail>(
				await api.post(`/api/v1/projects/${project.id}/issues`, {
					title: `Pin layout ${index + 1} ${runId}`,
					workflow_id: workflow.id
				})
			)
		)
	);
	await request.dispose();
});

test.beforeEach(async ({ context }) => {
	await signIn(context, ALICE.sessionToken);
});

const issueUrl = (issue: IssueDetail) =>
	`/issues/${encodeURIComponent(projectName)}/${issue.number}`;

const card = (page: Page) =>
	page.locator('section').filter({ has: page.getByText('Pin to a runner', { exact: true }) });

type Box = { x: number; y: number; width: number; height: number };

async function boxes(locators: Locator[]): Promise<Box[]> {
	return readSettled(
		() =>
			Promise.all(
				locators.map(async (locator) => {
					const box = await locator.boundingBox();
					expect(box).not.toBeNull();
					return box!;
				})
			),
		{ timeout: 5_000 }
	);
}

async function assertSelectedLabelFits(select: Locator): Promise<void> {
	const measurement = await select.evaluate((element: HTMLSelectElement) => {
		const style = getComputedStyle(element);
		const canvas = document.createElement('canvas');
		const context = canvas.getContext('2d');
		if (!context) throw new Error('canvas context unavailable');
		context.font = style.font;
		return {
			available:
				element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
			needed: context.measureText(element.selectedOptions[0]?.text ?? '').width
		};
	});
	expect(measurement.needed).toBeLessThanOrEqual(measurement.available + 1);
}

async function openIssue(page: Page, issue: IssueDetail, viewport: typeof DESKTOP): Promise<void> {
	await page.setViewportSize(viewport);
	await gotoHydrated(page, issueUrl(issue));
	if (viewport.width === PHONE.width) {
		await page.getByRole('button', { name: /^Agent activity/ }).click();
	}
	await expect(page.getByLabel('Pinned runner')).toBeVisible();
	await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
}

const cases = [
	{ theme: 'light', viewport: DESKTOP, issueIndex: 0 },
	{ theme: 'dark', viewport: DESKTOP, issueIndex: 1 },
	{ theme: 'light', viewport: PHONE, issueIndex: 2 },
	{ theme: 'dark', viewport: PHONE, issueIndex: 3 }
] as const;

for (const { theme, viewport, issueIndex } of cases) {
	test(`keeps pin labels readable at ${viewport.width}px in ${theme} mode`, async ({
		page
	}, testInfo) => {
		await page.addInitScript((savedTheme) => {
			localStorage.setItem('tines:theme', savedTheme);
		}, theme);
		await openIssue(page, issues[issueIndex], viewport);
		await expect(page.locator('html')).toHaveClass(
			theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/
		);

		const runnerSelect = page.getByLabel('Pinned runner');
		const tierSelect = page.getByLabel('Pinned tier');
		const save = card(page).getByRole('button', { name: 'Save' });
		const controls = runnerSelect.locator('..');
		await expect(runnerSelect).toHaveValue('');
		await expect(runnerSelect.locator('option:checked')).toHaveText('No pin');
		await expect(tierSelect.locator('option:checked')).toHaveText('Default tier');
		await expect(card(page).getByText('No pin uses routing rules.', { exact: true })).toBeVisible();

		const [containerBox, runnerBox, tierBox, saveBox] = await boxes([
			controls,
			runnerSelect,
			tierSelect,
			save
		]);
		expect(Math.abs(runnerBox.x - containerBox.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(runnerBox.width - containerBox.width)).toBeLessThanOrEqual(1);
		expect(tierBox.y).toBeGreaterThanOrEqual(runnerBox.y + runnerBox.height);
		expect(saveBox.y).toBeGreaterThanOrEqual(runnerBox.y + runnerBox.height);
		expect(saveBox.x - (tierBox.x + tierBox.width)).toBeGreaterThan(0);
		for (const controlBox of [runnerBox, tierBox, saveBox]) {
			expect(controlBox.x).toBeGreaterThanOrEqual(containerBox.x - 1);
			expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(
				containerBox.x + containerBox.width + 1
			);
		}
		await assertSelectedLabelFits(runnerSelect);
		await assertSelectedLabelFits(tierSelect);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			await page.evaluate(() => document.documentElement.clientWidth)
		);

		const screenshotTarget =
			viewport.width === PHONE.width
				? card(page).getByText('Pin to a runner', { exact: true }).locator('..')
				: card(page);
		if (viewport.width === PHONE.width) {
			await page.evaluate(() => window.scrollBy(0, 250));
		}
		await screenshotTarget.screenshot({
			path: testInfo.outputPath(`pin-runner-${theme}-${viewport.width}.png`)
		});
	});
}

test('saves a default tier, a concrete tier, and no pin', async ({ page, request }) => {
	const issue = issues[4];
	const api = apiClient(request, ALICE.apiKey);
	await openIssue(page, issue, DESKTOP);
	const runnerSelect = page.getByLabel('Pinned runner');
	const tierSelect = page.getByLabel('Pinned tier');
	const save = card(page).getByRole('button', { name: 'Save' });
	const readIssue = async () => body<IssueDetail>(await api.get(`/api/v1/issues/${issue.id}`));
	const saveAndWait = async () => {
		const response = page.waitForResponse(
			(candidate) =>
				candidate.request().method() === 'PATCH' &&
				candidate.url().endsWith(`/api/v1/issues/${issue.id}`)
		);
		await save.click();
		expect((await response).ok()).toBe(true);
		await expect(save).toBeDisabled();
	};

	await expect(tierSelect).toBeDisabled();
	await expect(save).toBeDisabled();
	await runnerSelect.selectOption(runner.id);
	await expect(tierSelect).toBeEnabled();
	await expect(save).toBeEnabled();
	await saveAndWait();
	await expect.poll(readIssue).toMatchObject({ pinned_runner_id: runner.id, pinned_tier: null });

	await tierSelect.selectOption('smartest');
	await saveAndWait();
	await page.reload({ waitUntil: 'networkidle' });
	await expect(page.getByLabel('Pinned runner')).toHaveValue(runner.id);
	await expect(page.getByLabel('Pinned tier')).toHaveValue('smartest');

	await page.getByLabel('Pinned runner').selectOption('');
	await saveAndWait();
	await expect.poll(readIssue).toMatchObject({ pinned_runner_id: null, pinned_tier: null });
	await expect(page.getByLabel('Pinned runner').locator('option:checked')).toHaveText('No pin');
	await expect(page.getByLabel('Pinned tier').locator('option:checked')).toHaveText('Default tier');
});
