import type { IssueDetail, Project, WorkflowResponse } from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, HANDOFF } from './constants.mjs';
import { apiClient, body, gotoHydrated, runId, signIn } from './helpers';

const projectName = `handoff-${runId}`;
let issue: IssueDetail;
let clarificationIssue: IssueDetail;

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
	const api = apiClient(request, ALICE.apiKey);
	const project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
	const workflow = await body<WorkflowResponse>(
		await api.post('/api/v1/workflows', {
			name: `Handoff ${runId}`,
			initial_state: 'Working',
			states: [
				{ name: 'Working', category: 'active' },
				{ name: 'Human Review', category: 'awaiting_human' },
				{ name: 'Needs Clarification', category: 'awaiting_human' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				{ name: 'Ready for human', from: 'Working', to: 'Human Review' },
				{ name: 'Ask for clarification', from: 'Working', to: 'Needs Clarification' },
				{ name: 'Approve', from: 'Human Review', to: 'Done' },
				{ name: 'Send back', from: 'Human Review', to: 'Working' }
			]
		})
	);
	const review = workflow.states.find((state) => state.name === 'Human Review')!;
	await body(
		await api.post('/api/v1/context', {
			kind: 'prompt',
			name: 'instructions',
			workflow_state_id: review.id,
			body: 'Check the implementation and its evidence.\n\n- **Approve** — accept the work\n- **Send back** — request changes'
		})
	);
	issue = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, {
			title: `Awaiting handoff ${runId}`,
			workflow_id: workflow.id,
			description: 'Description marker'
		})
	);
	issue = await body<IssueDetail>(
		await api.post(`/api/v1/issues/${issue.id}/transition`, { action: 'Ready for human' })
	);
	clarificationIssue = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, {
			title: `Clarification ${runId}`,
			workflow_id: workflow.id
		})
	);
	clarificationIssue = await body<IssueDetail>(
		await api.post(`/api/v1/issues/${clarificationIssue.id}/transition`, {
			action: 'Ask for clarification'
		})
	);
	await api.put(`/api/v1/issues/${clarificationIssue.id}/artifacts/clarification-request`, {
		type: 'text',
		content_type: 'text/plain',
		content: 'Which launch date should we use?\nAnswer with a date.'
	});

	const put = async (key: string, name: string, data: unknown) => {
		const response = await apiClient(request, key).put(
			`/api/v1/issues/${HANDOFF.issueId}/artifacts/${name}`,
			data
		);
		expect(response.ok(), await response.text()).toBe(true);
		return response;
	};
	await put(HANDOFF.runKeys.impl1, 'impl-pr', {
		type: 'pr',
		pr_url: 'https://github.com/acme/example/pull/78'
	});
	await put(HANDOFF.runKeys.impl2, 'impl-pr', {
		type: 'pr',
		pr_url: 'https://github.com/acme/example/pull/78'
	});
	await put(HANDOFF.runKeys.review1, 'review-notes', {
		type: 'text',
		content_type: 'text/markdown',
		content: '# First review\n\nChanges required.'
	});
	await put(HANDOFF.runKeys.review2, 'review-notes', {
		type: 'text',
		content_type: 'text/markdown',
		content: '# Passing review\n\nAll checks passed.'
	});
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
		'base64'
	);
	const uploadShots = async (key: string, suffix: string) => {
		const response = await request.put(
			`/api/v1/issues/${HANDOFF.issueId}/artifacts/screenshots/folder`,
			{
				headers: { authorization: `Bearer ${key}` },
				multipart: Object.fromEntries(
					[
						'dashboard-desktop.png',
						'dashboard-mobile.png',
						'settings-desktop.png',
						'settings-mobile.png'
					].map((path, index) => [
						`f${index}`,
						{ name: path, mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.from(suffix)]) }
					])
				)
			}
		);
		expect(response.ok(), await response.text()).toBe(true);
	};
	await uploadShots(HANDOFF.runKeys.review1, 'v1');
	await uploadShots(HANDOFF.runKeys.review2, 'v2');
	// Newer current version from a run working another issue: neither the card
	// nor its viewer selection may confuse this with the round's v2.
	await uploadShots(HANDOFF.runKeys.foreign, 'v3');
	await request.dispose();
});

test.beforeEach(async ({ context }) => signIn(context, ALICE.sessionToken));

test('awaiting page leads with its brief and owns desktop transitions once', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await gotoHydrated(page, `/issues/${encodeURIComponent(projectName)}/${issue.number}`);
	const card = page.getByTestId('handoff-card');
	await expect(card).toContainText('Check the implementation and its evidence.');
	await expect(card).toContainText('Arrived via Ready for human');
	await expect(card).toContainText('No agent work in this round.');
	await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(1);
	const stateCard = page.locator('section').filter({
		has: page.getByRole('heading', { name: 'State', exact: true })
	});
	await expect(stateCard.getByRole('button', { name: /Approve/ })).toHaveCount(0);
	const [handoffY, descriptionY] = await Promise.all([
		card.evaluate((node) => node.getBoundingClientRect().y),
		page
			.getByRole('heading', { name: 'Description', exact: true })
			.evaluate((node) => node.getBoundingClientRect().y)
	]);
	expect(handoffY).toBeLessThan(descriptionY);
});

test('phone keeps the brief, arrival, and pinned action visible while round details stay folded', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await gotoHydrated(page, `/issues/${encodeURIComponent(projectName)}/${issue.number}`);
	const card = page.getByTestId('handoff-card');
	await expect(card).toContainText('Check the implementation and its evidence.');
	await expect(card).toContainText('Arrived via Ready for human');
	await expect(page.getByRole('button', { name: /Approve/ })).toBeVisible();
	await expect(card.getByText('No agent work in this round.')).toBeVisible();
});

const richUrl = `/issues/${HANDOFF.projectName}/${HANDOFF.issueNumber}`;

test('renders the two-pass round, excludes foreign-run content, and opens the pinned screenshot', async ({
	page
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await gotoHydrated(page, richUrl);
	const card = page.getByTestId('handoff-card');
	await expect(card).toContainText('Review the implementation and all evidence.');
	await expect(card).toContainText('Arrived via Automated review passed');
	await expect(card).toContainText(HANDOFF.reviewerTail);
	await expect(card).toContainText(HANDOFF.implementerTail);
	await expect(card).not.toContainText(HANDOFF.strayBody);
	await expect(card.getByText('Automated Review', { exact: true })).toBeVisible();
	const headings = await card.locator('h3').allTextContents();
	expect(headings.indexOf('Automated Review')).toBeLessThan(headings.indexOf('Implementation'));
	await expect(card.getByText('impl-pr v1 → v2')).toBeVisible();
	await expect(card.getByRole('link', { name: /PR #78/ })).toBeVisible();
	await expect(
		card.getByText('1 earlier attempt · returned via Automated review failed')
	).toBeVisible();
	await expect(
		card.getByRole('button', { name: /dashboard-desktop\.png, screenshots version 2/ })
	).toBeVisible();
	await expect(
		card.getByRole('button', { name: /dashboard-mobile\.png, screenshots version 2/ })
	).toBeVisible();

	await card.getByRole('button', { name: /dashboard-mobile\.png, screenshots version 2/ }).click();
	const viewer = page.getByRole('dialog', { name: 'Artifact viewer' });
	await expect(viewer).toBeVisible();
	await expect(viewer.getByRole('combobox', { name: 'Version' })).toHaveValue('2');
	await expect(viewer.locator('img[alt="dashboard-mobile.png"]')).toHaveAttribute(
		'src',
		/version=2&path=dashboard-mobile\.png&inline=1/
	);
});

test('renders Product Direction and clarification handoffs inline', async ({ page }) => {
	await gotoHydrated(page, `/issues/${HANDOFF.projectName}/${HANDOFF.prdIssueNumber}`);
	let card = page.getByTestId('handoff-card');
	await expect(card).toContainText('Decide whether this product direction is ready to deliver.');
	await expect(card).toContainText('Drafting complete with every open question included.');
	await expect(card.getByText('prd v1')).toBeVisible();

	let failedOnce = false;
	await page.route('**/artifacts/clarification-request/content*', async (route) => {
		if (!failedOnce) {
			failedOnce = true;
			await route.fulfill({ status: 500, body: 'temporary failure' });
		} else await route.continue();
	});
	await gotoHydrated(
		page,
		`/issues/${encodeURIComponent(projectName)}/${clarificationIssue.number}`
	);
	card = page.getByTestId('handoff-card');
	await expect(card.getByText('Current clarification-request · v1')).toBeVisible();
	await expect(card.getByText('Couldn’t load the clarification request.')).toBeVisible();
	await card.getByRole('button', { name: 'Retry' }).click();
	await expect(card.locator('pre')).toContainText('Which launch date should we use?');
});

test('a missing historical screenshot path offers recovery instead of a blank viewer', async ({
	page
}) => {
	await page.route(`**/api/v1/issues/${HANDOFF.issueId}/artifacts/screenshots`, async (route) => {
		const response = await route.fetch();
		const envelope = (await response.json()) as {
			data: { versions: { version: number; files: { path: string }[] | null }[] };
		};
		const historical = envelope.data.versions.find((version) => version.version === 2);
		if (historical?.files)
			historical.files = historical.files.filter((file) => file.path !== 'dashboard-mobile.png');
		await route.fulfill({ response, json: envelope });
	});
	await gotoHydrated(page, richUrl);
	await page
		.getByTestId('handoff-card')
		.getByRole('button', { name: /dashboard-mobile\.png, screenshots version 2/ })
		.click();
	const viewer = page.getByRole('dialog', { name: 'Artifact viewer' });
	await expect(viewer.getByText('This file is unavailable in version 2.')).toBeVisible();
	await expect(viewer.getByRole('button', { name: 'Open the folder index' })).toBeVisible();
	await expect(viewer.getByRole('button', { name: 'Open the current version' })).toBeVisible();
});

test('Awaiting aliases show oldest waiting first and comments do not reset the wait clock', async ({
	page,
	request
}) => {
	await gotoHydrated(page, `/issues?project=${HANDOFF.projectName}&category=awaiting`);
	const rows = page.locator('a[href^="/issues/handoff-seed/"]');
	await expect(rows.filter({ hasText: 'Oldest awaiting' })).toBeVisible();
	const titles = await rows.locator('.title').allTextContents();
	expect(titles.indexOf('Oldest awaiting')).toBeLessThan(titles.indexOf('Rich handoff'));
	expect(titles.indexOf('Rich handoff')).toBeLessThan(titles.indexOf('Newest awaiting'));
	const rich = rows.filter({ hasText: 'Rich handoff' });
	await expect(rich).toContainText('via Automated review passed');
	await expect(rich).toContainText('PR #78');
	await expect(rich).toContainText('review-notes v2');
	const before = await rich.innerText();
	await apiClient(request, ALICE.apiKey).post(`/api/v1/issues/${HANDOFF.issueId}/comments`, {
		body: 'A new human comment must not reset waiting time.'
	});
	await page.reload({ waitUntil: 'networkidle' });
	await expect(rows.filter({ hasText: 'Rich handoff' })).toContainText(
		before.match(/waiting [^·\n]+/i)![0]
	);

	await page.goto('/issues?category=awaiting_human');
	await expect(page.getByText('Oldest awaiting')).toBeVisible();
});
