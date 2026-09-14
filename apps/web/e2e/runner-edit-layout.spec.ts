import type { Runner, RunnerTokenResponse } from '@tines/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ALICE, RUNROW } from './constants.mjs';
import {
	apiClient,
	body,
	clickToOpen,
	DESKTOP,
	gotoHydrated,
	PHONE,
	readSettled,
	runId,
	signIn
} from './helpers';

const PHONE_NARROW = { width: 320, height: 844 };
const TABLET_EDGE = { width: 640, height: 900 };
const runnerName = `runner-edit-layout-${runId}`;
const customRunnerName = `runner-edit-fixed-${runId}`;

let runner: Runner;
let customRunner: Runner;

test.describe.serial('runner edit responsive layout', () => {
	test.beforeAll(async ({ playwright }) => {
		const request = await playwright.request.newContext({
			baseURL: test.info().project.use.baseURL
		});
		const api = apiClient(request, ALICE.apiKey);
		const registered = await body<RunnerTokenResponse>(
			await api.post('/api/v1/runners/register', { name: runnerName, harness: 'codex' })
		);
		runner = registered.runner;
		const models = [...new Set(Object.values(runner.tier_models ?? {}))].map((model) => ({
			model,
			efforts: ['low', 'high', 'ultra']
		}));
		const poll = await request.post(`/api/v1/runners/${runner.id}/poll`, {
			headers: { authorization: `Bearer ${registered.runner_token}` },
			data: {
				instance_id: `runner-edit-layout-${runId}`,
				owned_runs: [],
				effort_capabilities: {
					version: 1,
					daemon_version: 'e2e',
					harness: 'codex',
					harness_version: 'e2e',
					catalog_digest: `runner-edit-layout-${runId}`,
					models
				}
			}
		});
		expect(poll.ok(), await poll.text()).toBe(true);
		const balanced = runner.tier_models?.balanced;
		expect(balanced).toBeTruthy();
		runner = await body<Runner>(
			await api.patch(`/api/v1/runners/${runner.id}`, {
				tiers: { balanced: { model: balanced, effort: 'high' } },
				budget: {
					daily_usd: 19,
					daily_tokens: 900_000,
					max_run_cost_usd: 2.5,
					max_run_tokens: 8_000
				}
			})
		);
		customRunner = (
			await body<RunnerTokenResponse>(
				await api.post('/api/v1/runners/register', {
					name: customRunnerName,
					harness: 'custom',
					command: 'true'
				})
			)
		).runner;
		await request.dispose();
	});

	test.afterAll(async ({ playwright }) => {
		const request = await playwright.request.newContext({
			baseURL: test.info().project.use.baseURL
		});
		const api = apiClient(request, ALICE.apiKey);
		for (const created of [runner, customRunner]) {
			if (created) await api.delete(`/api/v1/runners/${created.id}`);
		}
		await request.dispose();
	});

	test.beforeEach(async ({ context }) => {
		await signIn(context, ALICE.sessionToken);
	});

	test('uses a clear tier hierarchy while retaining responsive control rows', async ({
		page
	}, testInfo) => {
		for (const viewport of [PHONE_NARROW, PHONE, TABLET_EDGE, DESKTOP]) {
			const dialog = await openRunner(page, runner, viewport);
			const form = dialog.locator('form');
			const concurrent = dialog.locator('#edit-concurrent');
			const minutes = dialog.locator('#edit-minutes');
			const defaultTier = dialog.locator('#edit-default-tier');
			const tierHeading = dialog.locator('[data-tier-heading="balanced"]');
			const modelLabel = dialog.locator('label[for="edit-model-balanced"]');
			const model = dialog.locator('#edit-model-balanced');
			const effortLabel = dialog.locator('label[for="edit-effort-balanced"]');
			const effort = dialog.locator('#edit-effort-balanced');
			const cost = dialog.locator('#edit-cap-usd');
			const tokens = dialog.locator('#edit-cap-tokens');
			const geometry = await boxes([
				form,
				concurrent,
				minutes,
				defaultTier,
				tierHeading,
				model,
				effort,
				cost,
				tokens
			]);
			const [
				formBox,
				concurrentBox,
				minutesBox,
				defaultBox,
				tierHeadingBox,
				modelBox,
				effortBox,
				costBox,
				tokensBox
			] = geometry;

			for (const controlBox of [
				concurrentBox,
				minutesBox,
				defaultBox,
				modelBox,
				effortBox,
				costBox,
				tokensBox
			]) {
				expect(controlBox.x).toBeGreaterThanOrEqual(formBox.x - 1);
				expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(formBox.x + formBox.width + 1);
			}
			if (viewport.width < TABLET_EDGE.width) {
				expect(minutesBox.y).toBeGreaterThanOrEqual(concurrentBox.y + concurrentBox.height);
				expect(defaultBox.y).toBeGreaterThanOrEqual(minutesBox.y + minutesBox.height);
				const modelLabelBox = (await modelLabel.boundingBox())!;
				const effortLabelBox = (await effortLabel.boundingBox())!;
				expect(tierHeadingBox.y + tierHeadingBox.height).toBeLessThanOrEqual(modelLabelBox.y);
				expect(modelLabelBox.y + modelLabelBox.height).toBeLessThanOrEqual(modelBox.y);
				expect(modelBox.y + modelBox.height).toBeLessThanOrEqual(effortLabelBox.y);
				expect(effortLabelBox.y + effortLabelBox.height).toBeLessThanOrEqual(effortBox.y);
				expect(tokensBox.y).toBeGreaterThanOrEqual(costBox.y + costBox.height);
				expect(await textStyle(modelLabel)).toEqual(await textStyle(effortLabel));
				expect(parseFloat((await textStyle(tierHeading)).fontSize)).toBeGreaterThan(
					parseFloat((await textStyle(modelLabel)).fontSize)
				);
			} else {
				expect(concurrentBox.x + concurrentBox.width).toBeLessThan(minutesBox.x);
				expect(minutesBox.x + minutesBox.width).toBeLessThan(defaultBox.x);
				const summaryLabels = await boxes([
					dialog.locator('label[for="edit-concurrent"]'),
					dialog.locator('label[for="edit-minutes"]'),
					dialog.locator('label[for="edit-default-tier"]')
				]);
				expect(Math.max(...summaryLabels.map((box) => box.y))).toBeLessThanOrEqual(
					Math.min(...summaryLabels.map((box) => box.y)) + 1
				);
				const tierColumnLabels = [
					dialog.locator('[data-tier-column="tier"]'),
					dialog.locator('[data-tier-column="model"]'),
					dialog.locator('[data-tier-column="effort"]')
				];
				const tierColumnBoxes = await boxes(tierColumnLabels);
				expect(Math.max(...tierColumnBoxes.map((box) => box.y))).toBeLessThanOrEqual(
					Math.min(...tierColumnBoxes.map((box) => box.y)) + 1
				);
				expect(await textStyle(tierColumnLabels[0])).toEqual(await textStyle(tierColumnLabels[1]));
				expect(await textStyle(tierColumnLabels[1])).toEqual(await textStyle(tierColumnLabels[2]));
				expect(Math.abs(modelBox.y - effortBox.y)).toBeLessThanOrEqual(1);
				expect(
					Math.abs(
						tierHeadingBox.y + tierHeadingBox.height / 2 - (modelBox.y + modelBox.height / 2)
					)
				).toBeLessThanOrEqual(1);
				expect(Math.abs(costBox.y - tokensBox.y)).toBeLessThanOrEqual(1);
				expect((await modelLabel.boundingBox())!.width).toBeLessThanOrEqual(1);
				expect((await effortLabel.boundingBox())!.width).toBeLessThanOrEqual(1);
			}
			await assertSelectedLabelFits(effort);
			expect(await form.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
				await form.evaluate((element) => element.clientWidth)
			);
			expect(await dialog.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
				await dialog.evaluate((element) => element.clientWidth)
			);
			if (viewport.width < TABLET_EDGE.width) {
				expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
					await page.evaluate(() => document.documentElement.clientWidth)
				);
			}

			if (viewport.width === PHONE.width) {
				await dialog.screenshot({ path: testInfo.outputPath('runner-edit-phone-top.png') });
				await model.scrollIntoViewIfNeeded();
				await dialog.screenshot({ path: testInfo.outputPath('runner-edit-phone-tiers.png') });
			}
			const save = dialog.getByRole('button', { name: 'Save runner' });
			await save.scrollIntoViewIfNeeded();
			const saveBox = await save.boundingBox();
			const dialogBox = await dialog.boundingBox();
			expect(saveBox).not.toBeNull();
			expect(dialogBox).not.toBeNull();
			expect(saveBox!.y).toBeGreaterThanOrEqual(dialogBox!.y);
			expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(
				Math.min(dialogBox!.y + dialogBox!.height, viewport.height) + 1
			);
			if (viewport.width === PHONE.width) {
				await dialog.screenshot({ path: testInfo.outputPath('runner-edit-phone-bottom.png') });
			}
			if (viewport.width === DESKTOP.width) {
				await dialog.screenshot({ path: testInfo.outputPath('runner-edit-desktop.png') });
			}
			await dialog.getByRole('button', { name: 'Close' }).click();
		}
	});

	test('contains conditional phone states and keeps actions reachable', async ({ page }) => {
		let dialog = await openRunner(page, runner, PHONE);
		const model = dialog.locator('#edit-model-balanced');
		const effort = dialog.locator('#edit-effort-balanced');
		await model.fill('');
		await expect(effort).toBeDisabled();
		await expect(model).toHaveAttribute('placeholder', /built-in/);
		await expect(effort.locator('option:checked')).toHaveText('high');
		await model.fill('unknown-model-with-a-long-but-contained-identifier');
		await expect(effort.locator('option:checked')).toHaveText('high (incompatible)');
		await assertSelectedLabelFits(effort);
		await expect(dialog.getByText('stale override')).toHaveCount(0);
		await dialog.getByRole('button', { name: 'Cancel' }).click();

		dialog = await openRunner(page, customRunner, PHONE);
		await expect(dialog.getByText("Tiers don't apply to this runner")).toBeVisible();
		await expect(dialog.locator('#edit-default-tier')).toBeDisabled();
		await expect(dialog.locator('[id^="edit-model-"]')).toHaveCount(0);
		await expect(dialog.getByRole('button', { name: 'Save runner' })).toBeVisible();
		await dialog.getByRole('button', { name: 'Cancel' }).click();

		dialog = await openRunner(page, { id: RUNROW.runnerId } as Runner, PHONE);
		await expect(dialog.locator('#edit-api-key')).toBeVisible();
		await expect(dialog.getByText('No cost cap:')).toBeVisible();
		const managedModel = dialog.locator('#edit-model-smartest');
		await managedModel.fill('claude-opus-4-8');
		await expect(dialog.getByText('stale override')).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Save runner' })).toBeVisible();
	});

	test('persists edits and preserves daily budgets when caps change or clear', async ({
		page,
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		let dialog = await openRunner(page, runner, PHONE);
		const balanced = runner.tier_models?.balanced;
		expect(balanced).toBeTruthy();
		await dialog.locator('#edit-minutes').fill('47');
		await dialog.locator('#edit-default-tier').selectOption('cheapest');
		await dialog.locator('#edit-model-balanced').fill(balanced!);
		await dialog.locator('#edit-effort-balanced').selectOption('ultra');
		await dialog.locator('#edit-cap-usd').fill('2.75');
		await dialog.locator('#edit-cap-tokens').fill('8800');
		await saveAndWait(page, runner.id, dialog);
		let persisted = await body<Runner>(await api.get(`/api/v1/runners/${runner.id}`));
		expect(persisted).toMatchObject({
			max_run_minutes: 47,
			default_tier: 'cheapest',
			tiers: { balanced: { model: balanced, effort: 'ultra' } },
			budget: {
				daily_usd: 19,
				daily_tokens: 900_000,
				max_run_cost_usd: 2.75,
				max_run_tokens: 8_800
			}
		});

		dialog = await openRunner(page, runner, PHONE);
		await expect(dialog.locator('#edit-minutes')).toHaveValue('47');
		await expect(dialog.locator('#edit-default-tier')).toHaveValue('cheapest');
		await expect(dialog.locator('#edit-model-balanced')).toHaveValue(balanced!);
		await expect(dialog.locator('#edit-effort-balanced')).toHaveValue('ultra');
		await expect(dialog.locator('#edit-cap-usd')).toHaveValue('2.75');
		await expect(dialog.locator('#edit-cap-tokens')).toHaveValue('8800');
		await dialog.locator('#edit-model-balanced').fill('');
		await dialog.locator('#edit-cap-usd').fill('');
		await dialog.locator('#edit-cap-tokens').fill('');
		await saveAndWait(page, runner.id, dialog);
		persisted = await body<Runner>(await api.get(`/api/v1/runners/${runner.id}`));
		expect(persisted.tiers).toBeNull();
		expect(persisted.budget).toEqual({ daily_usd: 19, daily_tokens: 900_000 });

		dialog = await openRunner(page, runner, PHONE);
		await dialog.locator('#edit-minutes').fill('88');
		await dialog.getByRole('button', { name: 'Cancel' }).click();
		dialog = await openRunner(page, runner, PHONE);
		await expect(dialog.locator('#edit-minutes')).toHaveValue('47');
	});

	test('retains values and exits pending state after a save error', async ({ page }) => {
		const dialog = await openRunner(page, runner, PHONE);
		await dialog.locator('#edit-minutes').fill('53');
		await page.route(`**/api/v1/runners/${runner.id}`, async (route) => {
			if (route.request().method() !== 'PATCH') return route.continue();
			await route.fulfill({
				status: 422,
				contentType: 'application/json',
				body: JSON.stringify({
					error: { code: 'invalid_field', message: 'Runner settings rejected for this test' }
				})
			});
		});
		await dialog.getByRole('button', { name: 'Save runner' }).click();
		await expect(page.getByText('Runner settings rejected for this test')).toBeAttached();
		await expect(dialog.locator('#edit-minutes')).toHaveValue('53');
		await expect(dialog.getByRole('button', { name: 'Save runner' })).toBeEnabled();
	});
});

async function openRunner(
	page: Page,
	target: Pick<Runner, 'id'>,
	viewport: { width: number; height: number }
): Promise<Locator> {
	await page.setViewportSize(viewport);
	await gotoHydrated(page, '/agents#runners');
	const card = page.locator(`#runner-${target.id}`);
	await expect(card).toBeVisible();
	const dialog = page.getByRole('dialog', { name: 'Edit runner' });
	await clickToOpen(card.getByRole('button', { name: 'Edit' }), dialog);
	return dialog;
}

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

async function textStyle(locator: Locator): Promise<{
	color: string;
	fontSize: string;
	fontWeight: string;
}> {
	return locator.evaluate((element) => {
		const style = getComputedStyle(element);
		return { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight };
	});
}

async function saveAndWait(page: Page, runnerId: string, dialog: Locator): Promise<void> {
	const response = page.waitForResponse(
		(candidate) =>
			candidate.request().method() === 'PATCH' &&
			candidate.url().endsWith(`/api/v1/runners/${runnerId}`)
	);
	await dialog.getByRole('button', { name: 'Save runner' }).click();
	expect((await response).ok()).toBe(true);
	await expect(dialog).toHaveCount(0);
}
