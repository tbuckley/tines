import type { IssueDetail, Project, WorkflowResponse } from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, gotoHydrated, runId, signIn } from './helpers';

const projectName = `handoff-${runId}`;
let issue: IssueDetail;

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
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				{ name: 'Ready for human', from: 'Working', to: 'Human Review' },
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
