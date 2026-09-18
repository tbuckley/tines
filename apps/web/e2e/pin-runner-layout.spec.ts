import type { IssueDetail, Project, RunnerTokenResponse, WorkflowResponse } from '@tines/shared';
import type { Locator, Page } from '@playwright/test';
import { expect, test as base } from './fixtures';
import { ALICE } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import {
	apiClient,
	body,
	DESKTOP,
	gotoHydrated,
	PHONE,
	readSettled,
	runCleanupSteps
} from './helpers';

type PinWorld = {
	projectName: string;
	runner: RunnerTokenResponse['runner'];
	issues: IssueDetail[];
};
type PinAudit = {
	projectId?: string;
	runnerId?: string;
	workflowId?: string;
	issueIds: string[];
};

const test = base.extend<{}, { pinAudit: PinAudit; world: PinWorld }>({
	pinAudit: [
		async ({}, use) => {
			const audit: PinAudit = { issueIds: [] };
			await use(audit);
			const queries = [
				audit.projectId
					? `SELECT 'project:' || id AS owned FROM project WHERE id = ${sqlLiteral(audit.projectId)}`
					: null,
				audit.runnerId
					? `SELECT 'runner:' || id AS owned FROM runner WHERE id = ${sqlLiteral(audit.runnerId)}`
					: null,
				audit.workflowId
					? `SELECT 'workflow:' || id AS owned FROM workflow WHERE id = ${sqlLiteral(audit.workflowId)}`
					: null,
				audit.issueIds.length > 0
					? `SELECT 'issue:' || id AS owned FROM issue WHERE id IN (${audit.issueIds.map(sqlLiteral).join(', ')})`
					: null
			].filter((query): query is string => query !== null);
			const ownedRows =
				queries.length > 0 ? d1<{ owned: string }>(queries.join(' UNION ALL ')) : [];
			expect(ownedRows, 'pin layout teardown removes every owned row').toEqual([]);
		},
		{ scope: 'worker' }
	],
	world: [
		async ({ apiFor, pinAudit, uniqueName }, use) => {
			const api = apiFor(ALICE);
			const projectName = uniqueName('pin-layout');
			let projectId: string | undefined;
			let runnerId: string | undefined;
			let workflowId: string | undefined;
			const issueIds: string[] = [];
			try {
				const project = await body<Project>(
					await api.post('/api/v1/projects', { name: projectName })
				);
				projectId = project.id;
				pinAudit.projectId = project.id;
				const runner = (
					await body<RunnerTokenResponse>(
						await api.post('/api/v1/runners/register', {
							name: uniqueName('runner-name-that-stays-inside-the-full-width-control', {
								maxLength: 100
							}),
							harness: 'custom',
							command: 'true'
						})
					)
				).runner;
				runnerId = runner.id;
				pinAudit.runnerId = runner.id;
				const workflow = await body<WorkflowResponse>(
					await api.post('/api/v1/workflows', {
						name: uniqueName('Pin layout', { maxLength: 100 }),
						initial_state: 'Backlog',
						states: [
							{ name: 'Backlog', category: 'backlog' },
							{ name: 'Done', category: 'done' }
						],
						transitions: [{ name: 'Finish', from: 'Backlog', to: 'Done' }]
					})
				);
				workflowId = workflow.id;
				pinAudit.workflowId = workflow.id;
				const issues: IssueDetail[] = [];
				for (let index = 0; index < 5; index += 1) {
					const issue = await body<IssueDetail>(
						await api.post(`/api/v1/projects/${project.id}/issues`, {
							title: `Pin layout ${index + 1} ${project.id}`,
							workflow_id: workflow.id
						})
					);
					issues.push(issue);
					issueIds.push(issue.id);
					pinAudit.issueIds.push(issue.id);
				}
				await use({ projectName, runner, issues });
			} finally {
				await runCleanupSteps([
					...issueIds.map((id) => ({
						name: `clear pin layout issue ${id}`,
						run: async () => {
							expect(
								(await api.patch(`/api/v1/issues/${id}`, { pinned_runner_id: null })).status()
							).toBe(200);
						}
					})),
					...(runnerId
						? [
								{
									name: `delete pin layout runner ${runnerId}`,
									run: async () => {
										expect(
											(await api.delete(`/api/v1/runners/${runnerId}`, { force: true })).status()
										).toBe(204);
									}
								}
							]
						: []),
					...(issueIds.length > 0
						? [
								{
									name: 'delete pin layout issue addresses',
									run: async () => {
										const ids = issueIds.map(sqlLiteral).join(', ');
										d1(`DELETE FROM issue_address WHERE issue_id IN (${ids})`);
									}
								},
								{
									name: 'delete pin layout issues',
									run: async () => {
										const ids = issueIds.map(sqlLiteral).join(', ');
										d1(`DELETE FROM issue WHERE id IN (${ids})`);
									}
								}
							]
						: []),
					...(workflowId
						? [
								{
									name: `delete pin layout workflow ${workflowId}`,
									run: async () => {
										expect((await api.delete(`/api/v1/workflows/${workflowId}`)).status()).toBe(
											204
										);
									}
								}
							]
						: []),
					...(projectId
						? [
								{
									name: `delete pin layout project ${projectId}`,
									run: async () => {
										expect((await api.delete(`/api/v1/projects/${projectId}`)).status()).toBe(204);
									}
								}
							]
						: [])
				]);
			}
		},
		{ scope: 'worker' }
	]
});

test.use({ signedIn: ALICE });

const issueUrl = (world: PinWorld, issue: IssueDetail) =>
	`/issues/${encodeURIComponent(world.projectName)}/${issue.number}`;

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

async function openIssue(
	page: Page,
	world: PinWorld,
	issue: IssueDetail,
	viewport: typeof DESKTOP
): Promise<void> {
	await page.setViewportSize(viewport);
	await gotoHydrated(page, issueUrl(world, issue));
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
		page,
		world
	}, testInfo) => {
		await page.addInitScript((savedTheme) => {
			localStorage.setItem('tines:theme', savedTheme);
		}, theme);
		await openIssue(page, world, world.issues[issueIndex], viewport);
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

test('saves a default tier, a concrete tier, and no pin', async ({ page, request, world }) => {
	const issue = world.issues[4];
	const api = apiClient(request, ALICE.apiKey);
	await openIssue(page, world, issue, DESKTOP);
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
	await runnerSelect.selectOption(world.runner.id);
	await expect(tierSelect).toBeEnabled();
	await expect(save).toBeEnabled();
	await saveAndWait();
	await expect
		.poll(readIssue)
		.toMatchObject({ pinned_runner_id: world.runner.id, pinned_tier: null });

	await tierSelect.selectOption('smartest');
	await saveAndWait();
	await page.reload({ waitUntil: 'networkidle' });
	await expect(page.getByLabel('Pinned runner')).toHaveValue(world.runner.id);
	await expect(page.getByLabel('Pinned tier')).toHaveValue('smartest');

	await page.getByLabel('Pinned runner').selectOption('');
	await saveAndWait();
	await expect.poll(readIssue).toMatchObject({ pinned_runner_id: null, pinned_tier: null });
	await expect(page.getByLabel('Pinned runner').locator('option:checked')).toHaveText('No pin');
	await expect(page.getByLabel('Pinned tier').locator('option:checked')).toHaveText('Default tier');
});
