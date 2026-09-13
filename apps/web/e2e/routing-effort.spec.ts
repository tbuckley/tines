import type { Project, RoutingRule, RunnerTokenResponse } from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, clickToOpen, gotoHydrated, runId, signIn } from './helpers';

test('round-trips and clears a model-aware routing effort in the existing dialog', async ({
	context,
	page,
	request
}) => {
	const api = apiClient(request, ALICE.apiKey);
	const project = await body<Project>(
		await api.post('/api/v1/projects', { name: `routing-effort-${runId}` })
	);
	const registered = await body<RunnerTokenResponse>(
		await api.post('/api/v1/runners/register', {
			name: `routing-effort-${runId}`,
			harness: 'codex'
		})
	);
	const runner = registered.runner;
	const model = runner.tier_models?.balanced;
	expect(model).toBeTruthy();
	const poll = await request.post(`/api/v1/runners/${runner.id}/poll`, {
		headers: { authorization: `Bearer ${registered.runner_token}` },
		data: {
			instance_id: `routing-effort-${runId}`,
			owned_runs: [],
			effort_capabilities: {
				version: 1,
				daemon_version: 'e2e',
				harness: 'codex',
				harness_version: 'e2e',
				catalog_digest: 'e2e-routing-effort',
				models: [{ model, efforts: ['low', 'ultra'] }]
			}
		}
	});
	expect(poll.ok(), await poll.text()).toBe(true);

	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, `/agents?new=rule&project=${project.id}#routing`);
	const create = page.getByRole('dialog', { name: 'New routing rule' });
	await create.getByLabel('Target 1 runner').selectOption(runner.id);
	await create.getByLabel('Target 1 tier').selectOption('balanced');
	await create.getByLabel('Target 1 effort').selectOption('ultra');
	await create.getByRole('button', { name: 'Create rule' }).click();
	await expect(create).toHaveCount(0);

	const row = page
		.getByRole('list', { name: 'Routing rules' })
		.getByRole('listitem')
		.filter({ hasText: project.name });
	await expect(row).toContainText('effort ultra');
	await clickToOpen(row.getByRole('button', { name: 'Edit' }), page.getByRole('dialog'));
	const edit = page.getByRole('dialog', { name: 'Edit routing rule' });
	await expect(edit.getByLabel('Target 1 effort')).toHaveValue('ultra');
	await edit.getByLabel('Target 1 effort').selectOption('');
	await edit.getByRole('button', { name: 'Save rule' }).click();
	await expect(row).not.toContainText('effort ultra');

	const rules = await body<{ items: RoutingRule[] }>(await api.get('/api/v1/routing-rules'));
	const rule = rules.items.find((candidate) => candidate.scope.project_id === project.id);
	expect(rule?.targets).toHaveLength(1);
	expect(rule?.targets[0]).toMatchObject({ runner_id: runner.id, tier: 'balanced' });
	expect(rule?.targets[0]?.effort).toBeUndefined();
	if (rule) expect((await api.delete(`/api/v1/routing-rules/${rule.id}`)).ok()).toBe(true);
	expect((await api.delete(`/api/v1/runners/${runner.id}`)).ok()).toBe(true);
	expect((await api.delete(`/api/v1/projects/${project.id}`)).ok()).toBe(true);
});
