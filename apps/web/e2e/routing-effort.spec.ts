import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	AgentRun,
	ListResponse,
	Project,
	RoutingRule,
	Runner,
	RunnerTokenResponse
} from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, BASE_URL } from './constants.mjs';
import { apiClient, body, clickToOpen, gotoHydrated, runId, signIn } from './helpers';

const CLI_DIR = fileURLToPath(new URL('../../../packages/cli', import.meta.url));
const TSX = join(CLI_DIR, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = join(CLI_DIR, 'src', 'index.ts');

async function waitFor<T>(read: () => Promise<T | undefined>, timeout = 45_000): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error('timed out waiting for routed effort daemon');
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

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
	expect(
		await create.getByLabel('Target 1 runner').evaluate((el) => el.clientWidth)
	).toBeGreaterThan(180);
	await page.setViewportSize({ width: 390, height: 844 });
	const runnerBox = await create.getByLabel('Target 1 runner').boundingBox();
	const effortBox = await create.getByLabel('Target 1 effort').boundingBox();
	expect(runnerBox?.width).toBeGreaterThan(270);
	expect(effortBox!.y).toBeGreaterThan(runnerBox!.y + runnerBox!.height);
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

test('delivers routed effort through the source daemon argv and freezes its evidence', async ({
	request
}) => {
	test.setTimeout(70_000);
	const api = apiClient(request, ALICE.apiKey);
	const root = mkdtempSync(join(tmpdir(), 'tines-effort-e2e-'));
	const bin = join(root, 'bin');
	const config = join(root, 'config');
	const argvFile = join(root, 'argv.json');
	mkdirSync(bin);
	mkdirSync(config);
	const codex = join(bin, 'codex');
	writeFileSync(
		codex,
		`#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'app-server') {
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', line => {
    const m = JSON.parse(line);
    if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: {} }));
    if (m.method === 'model/list') console.log(JSON.stringify({ id: m.id, result: { data: [
      { model: 'gpt-5.6', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] },
      { model: 'gpt-5.6-codex', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] },
      { model: 'gpt-5.5-codex', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] },
      { model: 'gpt-5-codex', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] }
    ] } }));
  });
} else {
  fs.writeFileSync(process.env.E2E_CODEX_ARGV, JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread_effort_e2e' }));
}
`,
		{ mode: 0o755 }
	);
	const name = `effort-daemon-${runId}`;
	let output = '';
	let daemon: ChildProcess | null = spawn(
		TSX,
		[
			CLI_ENTRY,
			'runner',
			'daemon',
			'--url',
			BASE_URL,
			'--name',
			name,
			'--harness',
			'codex',
			'--poll-interval',
			'1',
			'--no-cli-refresh'
		],
		{
			cwd: CLI_DIR,
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				TINES_API_KEY: ALICE.apiKey,
				TINES_CONFIG_DIR: config,
				E2E_CODEX_ARGV: argvFile
			},
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);
	daemon.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
	daemon.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
	try {
		const runner = await waitFor(async () => {
			const runners = await body<ListResponse<Runner>>(await api.get('/api/v1/runners'));
			const found = runners.items.find((item) => item.name === name);
			const finalModel = found?.tier_models?.balanced;
			return finalModel && found?.effort_models?.[finalModel]?.includes('ultra')
				? found
				: undefined;
		});
		const model = runner.tier_models?.balanced;
		expect(model).toBeTruthy();
		const tierSave = await api.patch(`/api/v1/runners/${runner.id}`, {
			tiers: { balanced: { model, effort: 'ultra' } }
		});
		expect(tierSave.ok(), await tierSave.text()).toBe(true);
		const project = await body<Project>(
			await api.post('/api/v1/projects', { name: `effort-daemon-${runId}` })
		);
		const rule = await body<RoutingRule>(
			await api.post('/api/v1/routing-rules', {
				project_id: project.id,
				targets: [{ runner_id: runner.id, tier: 'balanced', effort: 'ultra' }]
			})
		);
		expect((await api.put('/api/v1/supervisor/settings', { enabled: true })).ok()).toBe(true);
		const issue = await body<{ id: string }>(
			await api.post(`/api/v1/projects/${project.id}/issues`, { title: 'Route effort into argv' })
		);
		const run = await waitFor(async () => {
			const runs = await body<ListResponse<AgentRun>>(
				await api.get(`/api/v1/runs?issue=${issue.id}`)
			);
			return runs.items.find((item) => item.status === 'completed');
		});
		await api.put('/api/v1/supervisor/settings', { enabled: false });
		const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
		expect(argv).toContain('model_reasoning_effort="ultra"');
		expect(run.requested_effort).toBe('ultra');
		expect(run.resolved_effort).toBe('ultra');
		expect(run.effort_application_status).toBe('accepted_unconfirmed');

		await api.patch(`/api/v1/routing-rules/${rule.id}`, {
			targets: [{ runner_id: runner.id, tier: 'balanced' }]
		});
		const frozen = await body<AgentRun>(await api.get(`/api/v1/runs/${run.id}`));
		expect(frozen.requested_effort).toBe('ultra');
		expect(frozen.effort_application_status).toBe('accepted_unconfirmed');
	} finally {
		await api.put('/api/v1/supervisor/settings', { enabled: false }).catch(() => undefined);
		if (daemon?.pid) daemon.kill('SIGKILL');
		daemon = null;
		rmSync(root, { recursive: true, force: true });
		if (output.includes('Error')) console.error(output);
	}
});
