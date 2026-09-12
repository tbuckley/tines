import type { IssueDetail, Project } from '@tines/shared';
import { expect, test, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, clickToOpen, gotoHydrated, resetFocus, runId, signIn } from './helpers';

test.beforeEach(async ({ page, request }) => {
	await resetFocus(request);
	await signIn(page.context(), ALICE.sessionToken);
});

async function seed(request: Parameters<typeof apiClient>[0], label: string) {
	const api = apiClient(request, ALICE.apiKey);
	const source = await body<Project>(
		await api.post('/api/v1/projects', { name: `xf-session-src-${label}-${runId}` })
	);
	const destinationA = await body<Project>(
		await api.post('/api/v1/projects', { name: `xf-session-a-${label}-${runId}` })
	);
	const destinationB = await body<Project>(
		await api.post('/api/v1/projects', { name: `xf-session-b-${label}-${runId}` })
	);
	const issue = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${source.id}/issues`, {
			title: 'Transfer preview session ownership'
		})
	);
	return { source, destinationA, destinationB, issue };
}

async function settleBrowser(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}

for (const closing of ['Escape', 'Close', 'chooser Cancel'] as const) {
	test(`${closing} abandons a held preview before a new dialog session`, async ({
		page,
		request
	}) => {
		const { source, destinationA, destinationB, issue } = await seed(
			request,
			closing.replace(' ', '-').toLowerCase()
		);
		await gotoHydrated(page, `/issues/${source.name}/${issue.number}`);

		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let captured!: () => void;
		const ready = new Promise<void>((resolve) => (captured = resolve));
		let previewRequests = 0;
		let transferPosts = 0;
		page.on('request', (candidate) => {
			if (candidate.url().includes('/transfer') && candidate.method() === 'POST') transferPosts++;
		});
		await page.route('**/api/v1/issues/*/transfer?*', async (route) => {
			previewRequests++;
			const response = await route.fetch();
			captured();
			await gate;
			await route.fulfill({ response });
		});

		const modal = page.getByRole('dialog');
		await clickToOpen(page.getByTestId('move-to-project'), modal);
		await modal.getByTestId('transfer-destination').selectOption(destinationA.id);
		const obsoleteFinished = page.waitForEvent('requestfinished', (candidate) =>
			candidate.url().includes('/transfer?')
		);
		await modal.getByRole('button', { name: 'Review move', exact: true }).click();
		await ready;

		if (closing === 'Escape') await page.keyboard.press('Escape');
		else if (closing === 'Close') await modal.getByRole('button', { name: 'Close' }).click();
		else await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(modal).toHaveCount(0);

		await clickToOpen(page.getByTestId('move-to-project'), modal);
		const chooser = modal.getByTestId('transfer-destination');
		await chooser.selectOption(destinationB.id);
		await expect(chooser).toHaveValue(destinationB.id);
		release();
		await obsoleteFinished;
		await settleBrowser(page);

		await expect(chooser).toHaveValue(destinationB.id);
		await expect(chooser).toBeFocused();
		await expect(modal.getByTestId('transfer-review')).toHaveCount(0);
		await expect(modal.getByRole('heading', { level: 3 })).toHaveCount(0);
		await expect(modal.getByRole('alert')).toHaveCount(0);
		expect(previewRequests).toBe(1);
		expect(transferPosts).toBe(0);
	});
}

test('review Cancel abandons a held stale-preview refresh before a new session', async ({
	page,
	request
}) => {
	const { source, destinationA, destinationB, issue } = await seed(request, 'review-cancel');
	await gotoHydrated(page, `/issues/${source.name}/${issue.number}`);
	const api = apiClient(request, ALICE.apiKey);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let captured!: () => void;
	const ready = new Promise<void>((resolve) => (captured = resolve));
	let previewRequests = 0;
	let transferPosts = 0;
	page.on('request', (candidate) => {
		if (candidate.url().includes('/transfer') && candidate.method() === 'POST') transferPosts++;
	});
	await page.route('**/api/v1/issues/*/transfer?*', async (route) => {
		previewRequests++;
		const response = await route.fetch();
		if (previewRequests === 2) {
			captured();
			await gate;
		}
		await route.fulfill({ response });
	});

	const modal = page.getByRole('dialog');
	await clickToOpen(page.getByTestId('move-to-project'), modal);
	await modal.getByTestId('transfer-destination').selectOption(destinationA.id);
	await modal.getByRole('button', { name: 'Review move', exact: true }).click();
	await expect(modal.getByTestId('transfer-review')).toContainText(destinationA.name);

	// Stale the signed witness, then hold the replacement review after the
	// worker has produced it. The old review (and its Cancel button) stays
	// visible while commit() awaits that refresh.
	await api.post('/api/v1/context', {
		kind: 'prompt',
		name: `xf-session-stale-review-cancel-${runId}`,
		project_id: destinationA.id,
		body: 'Changes the transfer witness after the operator reviewed it'
	});
	const obsoleteFinished = page.waitForEvent('requestfinished', (candidate) =>
		candidate.url().includes('/transfer?')
	);
	await modal.getByTestId('transfer-confirm').click();
	await ready;
	await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(modal).toHaveCount(0);

	await clickToOpen(page.getByTestId('move-to-project'), modal);
	const chooser = modal.getByTestId('transfer-destination');
	await chooser.selectOption(destinationB.id);
	await expect(chooser).toHaveValue(destinationB.id);
	release();
	await obsoleteFinished;
	await settleBrowser(page);

	await expect(chooser).toHaveValue(destinationB.id);
	await expect(chooser).toBeFocused();
	await expect(modal.getByTestId('transfer-review')).toHaveCount(0);
	await expect(modal.getByRole('heading', { level: 3 })).toHaveCount(0);
	await expect(modal.getByRole('alert')).toHaveCount(0);
	expect(previewRequests).toBe(2);
	expect(transferPosts).toBe(1);
	const unchanged = await body<IssueDetail>(await api.get(`/api/v1/issues/${issue.id}`));
	expect(unchanged.project_id).toBe(source.id);
});

test('changing destination abandons the held preview without leaving loading stuck', async ({
	page,
	request
}) => {
	const { source, destinationA, destinationB, issue } = await seed(request, 'destination-change');
	await gotoHydrated(page, `/issues/${source.name}/${issue.number}`);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let captured!: () => void;
	const ready = new Promise<void>((resolve) => (captured = resolve));
	await page.route('**/api/v1/issues/*/transfer?*', async (route) => {
		const response = await route.fetch();
		captured();
		await gate;
		await route.fulfill({ response });
	});

	const modal = page.getByRole('dialog');
	await clickToOpen(page.getByTestId('move-to-project'), modal);
	const chooser = modal.getByTestId('transfer-destination');
	await chooser.selectOption(destinationA.id);
	const obsoleteFinished = page.waitForEvent('requestfinished', (candidate) =>
		candidate.url().includes('/transfer?')
	);
	await modal.getByRole('button', { name: 'Review move', exact: true }).click();
	await ready;
	await chooser.selectOption(destinationB.id);
	await expect(modal.getByRole('button', { name: 'Review move', exact: true })).toBeEnabled();
	release();
	await obsoleteFinished;
	await settleBrowser(page);
	await expect(chooser).toHaveValue(destinationB.id);
	await expect(modal.getByTestId('transfer-review')).toHaveCount(0);
	await expect(modal.getByRole('button', { name: 'Review move', exact: true })).toBeEnabled();
});

test('the current held preview is accepted and focused', async ({ page, request }) => {
	const { source, destinationA, issue } = await seed(request, 'current');
	await gotoHydrated(page, `/issues/${source.name}/${issue.number}`);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let captured!: () => void;
	const ready = new Promise<void>((resolve) => (captured = resolve));
	await page.route('**/api/v1/issues/*/transfer?*', async (route) => {
		const response = await route.fetch();
		captured();
		await gate;
		await route.fulfill({ response });
	});

	const modal = page.getByRole('dialog');
	await clickToOpen(page.getByTestId('move-to-project'), modal);
	await modal.getByTestId('transfer-destination').selectOption(destinationA.id);
	await modal.getByRole('button', { name: 'Review move', exact: true }).click();
	await ready;
	release();
	const review = modal.getByTestId('transfer-review');
	await expect(review).toContainText(destinationA.name);
	await expect(modal.getByRole('heading', { level: 3 })).toBeFocused();
});
