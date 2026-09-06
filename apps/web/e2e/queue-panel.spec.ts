/**
 * The Now row (Tines/256): eligible issues with no run, grouped by why they
 * are waiting, with each verdict's remedy as a control on the same screen.
 *
 * The scenario needs no daemon. `POST /runners/register` leaves a runner that
 * has never polled — offline — so the group appears; one `POST /runners/:id/poll`
 * with the runner's own token heartbeats it online and lets the dispatch pass
 * claim an issue as `assigned` (poll-mode runs stay `assigned`; nothing
 * launches), which saturates a `max_concurrent: 1` runner. Raising the cap
 * from the panel then has to drain it without a reload.
 */
import type { IssueDetail, Project, RoutingRule, Runner, WorkflowResponse } from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, RUNROW } from './constants.mjs';
import { apiClient, body, runId, signIn } from './helpers';

const PROJECT_NAME = `queue-${runId}`;
const RUNNER_NAME = `queue-${runId}`;

let projectId: string;
let stateId: string;
let runnerId: string;
let runnerToken: string;
let ruleId: string;

test.describe.serial('the Now row', () => {
	test('seeds three eligible issues behind one offline runner', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const project = await body<Project>(await api.post('/api/v1/projects', { name: PROJECT_NAME }));
		projectId = project.id;

		// The project's own initial state, whatever the default workflow calls it.
		const workflow = await body<WorkflowResponse>(
			await api.get(`/api/v1/workflows/${project.default_workflow_id}`)
		);
		stateId = workflow.states.find((s) => s.category === 'active')!.id;
		expect(stateId, 'the default workflow has an active state').toBeTruthy();

		for (let i = 0; i < 3; i++) {
			const res = await api.post(`/api/v1/projects/${projectId}/issues`, {
				title: `waiting ${i} ${runId}`
			});
			expect(res.status(), 'seeded issue').toBe(201);
		}

		const registered = await api.post('/api/v1/runners/register', {
			name: RUNNER_NAME,
			harness: 'custom',
			command: 'true',
			max_concurrent: 1
		});
		expect(registered.status()).toBe(201);
		const runner = await registered.json();
		runnerId = runner.id;
		runnerToken = runner.token;
		expect(runnerToken, 'the register response carries the runner token').toBeTruthy();

		// Project-scoped: a global rule would route every other spec's issues here.
		const rule = await body<RoutingRule>(
			await api.post('/api/v1/routing-rules', {
				project_id: projectId,
				targets: [{ runner_id: runnerId }]
			})
		);
		ruleId = rule.id;

		expect((await api.put('/api/v1/supervisor/settings', { enabled: true })).status()).toBe(200);
	});

	test('reads "3 waiting · <runner> offline" at the top of /agents', async ({ context, page }) => {
		await signIn(context, ALICE.sessionToken);
		await page.goto('/agents');

		const panel = page.getByRole('region', { name: 'Waiting for an agent' });
		await expect(panel).toContainText(`${RUNNER_NAME} offline`);
		await expect(panel).toContainText('3 issues');
		// Flow 18's remedy, rendered in place rather than linked away.
		await expect(panel).toContainText('tines runner daemon');

		// Part 3: the annotations, on the runner card and the rule row.
		await expect(page.getByRole('link', { name: '3 waiting', exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: /3 waiting · oldest/ }).first()).toBeVisible();
	});

	test('answers a run key on the queue and the settings read, without the PAT hint', async ({
		request
	}) => {
		const api = apiClient(request, RUNROW.runKey);
		const queue = await api.get('/api/v1/supervisor/queue');
		expect(queue.status()).toBe(200);
		const groups = (await queue.json()).groups as { verdict: string; runner_name: string }[];
		expect(groups.some((g) => g.runner_name === RUNNER_NAME && g.verdict === 'offline')).toBe(true);

		const settings = await api.get('/api/v1/supervisor/settings');
		expect(settings.status()).toBe(200);
		expect((await settings.json()).github_pat_hint).toBeNull();
	});

	test('flips to "at capacity" once the runner polls and claims one', async ({
		context,
		page,
		request
	}) => {
		const poll = await request.post(`/api/v1/runners/${runnerId}/poll`, {
			headers: { authorization: `Bearer ${runnerToken}` },
			data: { owned_runs: [] }
		});
		expect(poll.status()).toBe(200);

		await signIn(context, ALICE.sessionToken);
		await page.goto('/agents');
		const panel = page.getByRole('region', { name: 'Waiting for an agent' });
		await expect(panel).toContainText(`at capacity on ${RUNNER_NAME} (1/1)`, { timeout: 15_000 });
		await expect(panel).toContainText('2 issues');
	});

	test('drains the group when the cap is raised from the panel, without a reload', async ({
		context,
		page,
		request
	}) => {
		// The online window is two minutes; re-poll so the verdict is capacity,
		// not the runner having gone quiet while the previous test ran.
		await request.post(`/api/v1/runners/${runnerId}/poll`, {
			headers: { authorization: `Bearer ${runnerToken}` },
			data: { owned_runs: [] }
		});

		await signIn(context, ALICE.sessionToken);
		await page.goto('/agents');
		const panel = page.getByRole('region', { name: 'Waiting for an agent' });
		await expect(panel).toContainText(`at capacity on ${RUNNER_NAME}`, { timeout: 15_000 });

		await panel.getByRole('button', { name: `Raise cap on ${RUNNER_NAME}` }).click();
		const capField = page.locator('#edit-concurrent');
		await expect(capField).toBeVisible();
		await capField.fill('3');
		await page.getByRole('button', { name: /Save/ }).first().click();

		// No `page.reload()`: the shrink has to arrive through the invalidation
		// the write schedules, which is the point of the acceptance criterion.
		await expect(panel).toContainText('Waiting for an agent — 0', { timeout: 20_000 });
	});

	test('cleans up the fixture fleet', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		// Disabling cancels the claims this spec seeded, fleet-wide.
		await api.put('/api/v1/supervisor/settings', { enabled: false });
		await api.delete(`/api/v1/routing-rules/${ruleId}`);
		await api.delete(`/api/v1/runners/${runnerId}`, { force: true });
		const runners = await body<{ items: Runner[] }>(await api.get('/api/v1/runners'));
		expect(runners.items.some((r) => r.id === runnerId)).toBe(false);
		const issues = await body<{ items: IssueDetail[] }>(
			await api.get(`/api/v1/projects/${projectId}/issues`)
		);
		expect(issues.items.length).toBe(3);
	});
});
