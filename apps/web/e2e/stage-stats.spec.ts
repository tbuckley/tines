/**
 * The This week row's route and UI wiring: project narrowing, lever links and
 * sent-back evidence. The fixture uses API writes only; no runner daemon.
 */
import type { ContextItem, IssueDetail, Project, WorkflowResponse } from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, clickToOpen, gotoHydrated, runId, signIn } from './helpers';

const projectName = `stage-stats-${runId}`;
const otherProjectName = `stage-stats-other-${runId}`;
let project: Project;
let workflow: WorkflowResponse;
let reviewStateId: string;

test.beforeAll(async ({ playwright }) => {
	const request = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
	const api = apiClient(request, ALICE.apiKey);
	workflow = await body<WorkflowResponse>(
		await api.post('/api/v1/workflows', {
			name: `Stage stats ${runId}`,
			initial_state: 'Implementation',
			states: [
				{ name: 'Implementation', category: 'active' },
				{ name: 'Automated Review', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				{ name: 'submit', from: 'Implementation', to: 'Automated Review' },
				{ name: 'send back', from: 'Automated Review', to: 'Implementation' },
				{ name: 'finish', from: 'Automated Review', to: 'Done' }
			]
		})
	);
	reviewStateId = workflow.states.find((state) => state.name === 'Automated Review')!.id;
	project = await body<Project>(
		await api.post('/api/v1/projects', {
			name: projectName,
			default_workflow_id: workflow.id
		})
	);
	const other = await body<Project>(
		await api.post('/api/v1/projects', {
			name: otherProjectName,
			default_workflow_id: workflow.id
		})
	);
	await body<ContextItem>(
		await api.post('/api/v1/context', {
			kind: 'prompt',
			name: 'instructions',
			workflow_state_id: reviewStateId,
			body: 'Review carefully.'
		})
	);

	const seedVisit = async (projectId: string, title: string, sendBack: boolean) => {
		let issue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${projectId}/issues`, { title })
		);
		const submit = issue.allowed_transitions.find((transition) => transition.name === 'submit')!;
		issue = await body<IssueDetail>(
			await api.post(`/api/v1/issues/${issue.id}/transition`, {
				transition_id: submit.transition_id
			})
		);
		if (sendBack) {
			await api.post(`/api/v1/issues/${issue.id}/comments`, {
				body: 'Please address the findings.'
			});
			const back = issue.allowed_transitions.find((transition) => transition.name === 'send back')!;
			await api.post(`/api/v1/issues/${issue.id}/transition`, {
				transition_id: back.transition_id
			});
		}
	};
	await seedVisit(project.id, `Sent back ${runId}`, true);
	await seedVisit(other.id, `Other visit ${runId}`, false);
	await request.dispose();
});

test('filters the weekly row and opens its evidence and lever links', async ({ context, page }) => {
	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, `/agents?project=${project.id}`);

	const projectFilter = page.locator(`select:has(option[value="${project.id}"])`).first();
	await expect(projectFilter).toHaveValue(project.id);
	const section = page.getByRole('region', { name: /This week/ });
	const row = section.getByRole('row').filter({ hasText: 'Automated Review' });
	await expect(row).toContainText('1 · 1');
	await expect(row.getByRole('link', { name: /Stage stats.*Automated Review/ })).toHaveAttribute(
		'href',
		new RegExp(`/workflows/${workflow.id}\\?state=${reviewStateId}#state-${reviewStateId}`)
	);
	const links = row.getByRole('link');
	await expect(links.nth(1)).toHaveAttribute('href', '#quota-policy');
	for (const index of [2, 3, 4]) {
		await expect(links.nth(index)).toHaveAttribute(
			'href',
			`/agents?runs_state=${reviewStateId}#runs`
		);
	}

	const dialog = page.getByRole('dialog', { name: 'Issues sent back' });
	await clickToOpen(row.getByRole('button', { name: /1 of 1/ }), dialog);
	await expect(dialog).toContainText('prompt v1');
	await expect(dialog).toContainText('Please address the findings.');
	await expect(dialog.getByRole('link', { name: /Edit prompt/ })).toHaveAttribute(
		'href',
		new RegExp(`/workflows/${workflow.id}\\?state=${reviewStateId}`)
	);
});

test('keeps the weekly table and project filter usable on a phone', async ({ context, page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, `/agents?project=${project.id}`);
	await expect(page.locator(`select:has(option[value="${project.id}"])`).first()).toHaveValue(
		project.id
	);
	await expect(page.getByRole('region', { name: /This week/ }).getByRole('table')).toBeVisible();
});
