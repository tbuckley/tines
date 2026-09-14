import type { IssueDetail, ListResponse, Project, WorkflowResponse } from '@tines/shared';
import { expect, test, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, clickToOpen, gotoHydrated, resetFocus, runId, signIn } from './helpers';

test.describe.serial('issue workflow filter', () => {
	const projectName = `workflow-filter-${runId}`;
	const workflowName = `Engineering filter ${runId}`;
	const otherWorkflowName = `Support filter ${runId}`;
	const emptyWorkflowName = `Empty filter ${runId}`;
	let project: Project;
	let workflow: WorkflowResponse;
	let otherWorkflow: WorkflowResponse;
	let emptyWorkflow: WorkflowResponse;
	let openIssue: IssueDetail;
	let reviewIssue: IssueDetail;
	let otherIssue: IssueDetail;

	test.beforeAll(async ({ playwright }) => {
		const request = await playwright.request.newContext({
			baseURL: test.info().project.use.baseURL
		});
		const api = apiClient(request, ALICE.apiKey);
		project = await body<Project>(await api.post('/api/v1/projects', { name: projectName }));
		workflow = await body<WorkflowResponse>(
			await api.post('/api/v1/workflows', {
				name: workflowName,
				initial_state: 'Build',
				states: [
					{ name: 'Build', category: 'active' },
					{ name: 'Review', category: 'awaiting_human' },
					{ name: 'Shipped', category: 'done' }
				],
				transitions: [
					{ name: 'review', from: 'Build', to: 'Review' },
					{ name: 'ship', from: 'Review', to: 'Shipped' }
				]
			})
		);
		otherWorkflow = await body<WorkflowResponse>(
			await api.post('/api/v1/workflows', {
				name: otherWorkflowName,
				initial_state: 'Triage',
				states: [
					{ name: 'Triage', category: 'active' },
					{ name: 'Review', category: 'awaiting_human' }
				],
				transitions: []
			})
		);
		emptyWorkflow = await body<WorkflowResponse>(
			await api.post('/api/v1/workflows', {
				name: emptyWorkflowName,
				initial_state: 'Waiting',
				states: [{ name: 'Waiting', category: 'active' }],
				transitions: []
			})
		);

		const create = (title: string, workflowId: string) =>
			body<IssueDetail>(
				api.post(`/api/v1/projects/${project.id}/issues`, {
					title,
					workflow_id: workflowId
				})
			);
		openIssue = await create(`Workflow build ${runId}`, workflow.id);
		reviewIssue = await create(`Workflow review ${runId}`, workflow.id);
		await body(await api.post(`/api/v1/issues/${reviewIssue.id}/transition`, { action: 'review' }));
		otherIssue = await create(`Workflow triage ${runId}`, otherWorkflow.id);
		await request.dispose();
	});

	test.beforeEach(async ({ context, request }) => {
		await signIn(context, ALICE.sessionToken);
		await resetFocus(request);
	});

	async function openFilters(page: Page) {
		await clickToOpen(
			page.getByRole('button', { name: /^Filter/ }),
			page.getByLabel('Filter by workflow')
		);
	}

	test('chooses a workflow first, then one of only its states', async ({ page }) => {
		await gotoHydrated(page, `/projects/${project.id}`);
		await openFilters(page);
		const state = page.getByLabel('Filter by state');
		await expect(state).toBeDisabled();
		await expect(page.getByText('Choose a workflow first')).toBeVisible();

		await page.getByLabel('Filter by workflow').selectOption(workflow.id);
		await expect(page).toHaveURL(new RegExp(`workflow=${workflow.id}`));
		await expect(page).not.toHaveURL(/state=/);
		await expect(page.getByText(openIssue.title, { exact: true })).toBeVisible();
		await expect(page.getByText(reviewIssue.title, { exact: true })).toBeVisible();
		await expect(page.getByText(otherIssue.title, { exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Filter, 1 active' })).toBeVisible();
		await expect(
			page.getByRole('button', { name: `Remove filter workflow: ${workflowName}` })
		).toBeVisible();

		await expect(state).toBeEnabled();
		await expect(state.locator('option')).toHaveText(['Any state', 'Build', 'Review', 'Shipped']);
		await expect(state.locator('option', { hasText: 'Triage' })).toHaveCount(0);
		const reviewState = workflow.states.find((item) => item.name === 'Review')!;
		await state.selectOption(reviewState.id);
		await expect(page).toHaveURL(new RegExp(`state=${reviewState.id}`));
		await expect(page.getByText(reviewIssue.title, { exact: true })).toBeVisible();
		await expect(page.getByText(openIssue.title, { exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Filter, 2 active' })).toBeVisible();

		await page.getByRole('button', { name: 'Remove filter state: Review' }).click();
		await expect(page).not.toHaveURL(/state=/);
		await expect(page).toHaveURL(new RegExp(`workflow=${workflow.id}`));
		await expect(page.getByText(openIssue.title, { exact: true })).toBeVisible();
	});

	test('changes or removes workflow and state in one navigation', async ({ page }) => {
		const reviewState = workflow.states.find((item) => item.name === 'Review')!;
		const boundary = Buffer.from('9999999999999:iss_boundary').toString('base64url');
		await gotoHydrated(
			page,
			`/projects/${project.id}?workflow=${workflow.id}&state=${reviewState.id}&after=${boundary}&page_scope=old`
		);
		await openFilters(page);
		await page.getByLabel('Filter by workflow').selectOption(otherWorkflow.id);
		await expect(page).toHaveURL(new RegExp(`workflow=${otherWorkflow.id}`));
		for (const parameter of ['state', 'after', 'before', 'page_scope']) {
			expect(new URL(page.url()).searchParams.has(parameter)).toBe(false);
		}
		await expect(page.getByText(otherIssue.title, { exact: true })).toBeVisible();

		await page
			.getByRole('button', { name: `Remove filter workflow: ${otherWorkflowName}` })
			.click();
		expect(new URL(page.url()).searchParams.has('workflow')).toBe(false);
		expect(new URL(page.url()).searchParams.has('state')).toBe(false);
		await expect(page.getByText(openIssue.title, { exact: true })).toBeVisible();
	});

	test('keeps legacy and stale URL filters visible and removable', async ({ page }) => {
		await gotoHydrated(page, `/projects/${project.id}?state=Review`);
		await expect(page.getByRole('button', { name: 'Remove filter state: Review' })).toBeVisible();
		await openFilters(page);
		await expect(page.getByLabel('Filter by state')).toBeDisabled();
		await expect(page.getByText('Choose a workflow first')).toBeVisible();

		await gotoHydrated(page, `/projects/${project.id}?workflow=wf_missing&state=s_missing`);
		await expect(page.getByText('No issues match these filters.')).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Remove filter workflow: wf_missing' })
		).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Remove filter state: s_missing' })
		).toBeVisible();
		await openFilters(page);
		await expect(page.getByLabel('Filter by workflow')).toHaveValue(/__current-workflow/);
		await expect(page.getByText('Choose an available workflow first')).toBeVisible();

		await gotoHydrated(page, `/projects/${project.id}?workflow=${emptyWorkflow.id}`);
		await expect(page.getByText('No issues match these filters.')).toBeVisible();
	});

	test('matches global and nested APIs and remains usable at 320px', async ({ page, request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const global = await body<ListResponse<IssueDetail>>(
			await api.get(
				`/api/v1/issues?project=${project.id}&workflow=${encodeURIComponent(workflowName)}`
			)
		);
		const nested = await body<ListResponse<IssueDetail>>(
			await api.get(
				`/api/v1/projects/${project.id}/issues?workflow=${encodeURIComponent(workflowName)}`
			)
		);
		expect(nested.items.map((item) => item.id).sort()).toEqual(
			global.items.map((item) => item.id).sort()
		);

		await page.setViewportSize({ width: 320, height: 640 });
		await gotoHydrated(page, `/projects/${project.id}?workflow=${workflow.id}`);
		await openFilters(page);
		await expect(page.getByLabel('Filter by workflow')).toBeInViewport();
		await expect(page.getByLabel('Filter by state')).toBeInViewport();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
			)
		).toBe(true);
	});
});
