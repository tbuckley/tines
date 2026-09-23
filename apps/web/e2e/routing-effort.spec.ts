import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	AgentRun,
	IssueDetail,
	ListResponse,
	Project,
	RoutingRule,
	Runner,
	RunnerPollResponse,
	RunnerTokenResponse
} from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE, BASE_URL } from './constants.mjs';
import {
	apiClient,
	body,
	clickToOpen,
	gotoHydrated,
	resetFocus,
	runCleanupSteps,
	signIn
} from './helpers';

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

async function waitForEndedRun<T extends Pick<AgentRun, 'id' | 'ended_at'>>(
	readRuns: () => Promise<readonly T[]>,
	expectedRunId: string
): Promise<T> {
	return waitFor(async () => {
		const items = await readRuns();
		return items.find((item) => item.id === expectedRunId && item.ended_at !== null);
	});
}

test('waits for the named routed-effort run when another run ends first', async () => {
	const issueId = 'issue-routing-effort';
	const unrelatedRunId = 'run-unrelated';
	const targetRunId = 'run-target';
	type SnapshotRun = Pick<AgentRun, 'id' | 'issue_id' | 'ended_at'>;
	const unrelated = { id: unrelatedRunId, issue_id: issueId, ended_at: '2026-09-23T00:00:01Z' };
	const snapshots: readonly SnapshotRun[][] = [
		[unrelated],
		[unrelated, { id: targetRunId, issue_id: issueId, ended_at: null }],
		[unrelated, { id: targetRunId, issue_id: issueId, ended_at: '2026-09-23T00:00:02Z' }]
	];
	let reads = 0;
	const ended = await waitForEndedRun(async () => snapshots[reads++] ?? [], targetRunId);

	expect(ended).toMatchObject({ id: targetRunId, issue_id: issueId });
	expect(reads).toBe(3);

	const completedTarget = await waitForEndedRun(
		async () => [{ id: targetRunId, issue_id: issueId, ended_at: '2026-09-23T00:00:03Z' }],
		targetRunId
	);
	expect(completedTarget.id).toBe(targetRunId);
});

test('round-trips and clears a model-aware routing effort in the existing dialog', async ({
	context,
	page,
	request,
	uniqueName
}) => {
	const api = apiClient(request, ALICE.apiKey);
	await resetFocus(request);
	const fixtureName = uniqueName('routing-effort');
	const project = await body<Project>(await api.post('/api/v1/projects', { name: fixtureName }));
	const registered = await body<RunnerTokenResponse>(
		await api.post('/api/v1/runners/register', {
			name: fixtureName,
			harness: 'codex'
		})
	);
	const runner = registered.runner;
	const model = runner.tier_models?.balanced;
	expect(model).toBeTruthy();
	const poll = await request.post(`/api/v1/runners/${runner.id}/poll`, {
		headers: { authorization: `Bearer ${registered.runner_token}` },
		data: {
			instance_id: fixtureName,
			owned_runs: [],
			effort_capabilities: {
				version: 1,
				daemon_version: 'e2e',
				harness: 'codex',
				harness_version: 'e2e',
				catalog_digest: 'e2e-routing-effort',
				models: [{ model, efforts: ['low', 'ultra'] }],
				accepts_asserted_effort: true
			}
		}
	});
	expect(poll.ok(), await poll.text()).toBe(true);
	const assertedModel = 'gpt-e2e-unlisted';
	const assertedSave = await api.patch(`/api/v1/runners/${runner.id}`, {
		tiers: { balanced: { model: assertedModel } }
	});
	expect(assertedSave.ok(), await assertedSave.text()).toBe(true);

	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, `/agents?new=rule&project=${project.id}#routing`);
	const create = page.getByRole('dialog', { name: 'New routing rule' });
	await create.getByLabel('Target 1 runner').selectOption(runner.id);
	await create.getByLabel('Target 1 tier').selectOption('balanced');
	await create.getByLabel('Target 1 effort').selectOption('ultra');
	expect(
		await create.getByLabel('Target 1 runner').evaluate((el) => el.clientWidth)
	).toBeGreaterThan(180);
	const dialogBox = await create.boundingBox();
	const rowBox = await create.locator('[data-routing-target-row]').boundingBox();
	for (const control of [
		create.getByLabel('Target 1 runner'),
		create.getByLabel('Target 1 effort'),
		create.getByLabel('Target 1 tier'),
		create.getByRole('button', { name: 'Move up' }),
		create.getByRole('button', { name: 'Move down' }),
		create.getByRole('button', { name: 'Remove target' })
	]) {
		const box = await control.boundingBox();
		expect(box!.x).toBeGreaterThanOrEqual(rowBox!.x);
		// Native selects include a two-pixel painted border beyond the CSS grid box.
		expect(box!.x + box!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 3);
		expect(box!.x + box!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width + 1);
	}
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
	request,
	uniqueName
}) => {
	test.setTimeout(70_000);
	const api = apiClient(request, ALICE.apiKey);
	const root = mkdtempSync(join(tmpdir(), 'tines-effort-e2e-'));
	const bin = join(root, 'bin');
	const config = join(root, 'config');
	const argvFile = join(root, 'argv.json');
	const probeFailureFile = join(root, 'fail-probe');
	mkdirSync(bin);
	mkdirSync(config);
	const codex = join(bin, 'codex');
	writeFileSync(
		codex,
		`#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') {
  console.log('codex-cli 0.153.4');
} else if (process.argv[2] === 'app-server') {
	  const fail = fs.existsSync(process.env.E2E_CODEX_PROBE_FAILURE);
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', line => {
    const m = JSON.parse(line);
    if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: {} }));
    if (m.method === 'model/list') console.log(JSON.stringify({ id: m.id, result: { data: fail ? [] : [
      { model: 'gpt-5.6', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] },
      { model: 'gpt-5.6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] },
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
	const name = uniqueName('effort-daemon');
	let runnerId: string | undefined;
	let projectId: string | undefined;
	let ruleId: string | undefined;
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
				E2E_CODEX_ARGV: argvFile,
				E2E_CODEX_PROBE_FAILURE: probeFailureFile
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
		runnerId = runner.id;
		const model = runner.tier_models?.balanced;
		expect(model).toBeTruthy();
		expect(
			runner.effort_capabilities?.version === 1
				? runner.effort_capabilities.harness_version
				: undefined
		).toBe('codex-cli 0.153.4');
		const tierSave = await api.patch(`/api/v1/runners/${runner.id}`, {
			tiers: { balanced: { model, effort: 'ultra' } }
		});
		expect(tierSave.ok(), await tierSave.text()).toBe(true);
		const project = await body<Project>(
			await api.post('/api/v1/projects', {
				// Projects containing run history can only be archived through the public API.
				// Keep their archived picker label inside the suite's 320 px envelope.
				name: uniqueName('effort-daemon-project', { maxLength: 32 })
			})
		);
		projectId = project.id;
		const rule = await body<RoutingRule>(
			await api.post('/api/v1/routing-rules', {
				project_id: project.id,
				targets: [{ runner_id: runner.id, tier: 'balanced', effort: 'ultra' }]
			})
		);
		ruleId = rule.id;
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
		const modelFlag = argv.indexOf('--model');
		expect(modelFlag).toBeGreaterThanOrEqual(0);
		expect(argv[modelFlag + 1]).toBe(model);
		expect(run.model).toBe(model);
		expect(run.requested_effort).toBe('ultra');
		expect(run.resolved_effort).toBe('ultra');
		expect(run.effort_application_status).toBe('accepted_unconfirmed');

		await api.patch(`/api/v1/routing-rules/${rule.id}`, {
			targets: [{ runner_id: runner.id, tier: 'balanced' }]
		});
		const frozen = await body<AgentRun>(await api.get(`/api/v1/runs/${run.id}`));
		expect(frozen.requested_effort).toBe('ultra');
		expect(frozen.effort_application_status).toBe('accepted_unconfirmed');

		// The assignment is made from the last advertised catalog, then the
		// daemon's mandatory launch-time reprobe changes. Nothing is spawned and
		// the immutable run records the rejected delivery rather than dropping it.
		await api.patch(`/api/v1/routing-rules/${rule.id}`, {
			targets: [{ runner_id: runner.id, tier: 'balanced', effort: 'ultra' }]
		});
		expect((await api.put('/api/v1/supervisor/settings', { enabled: true })).ok()).toBe(true);
		daemon?.kill('SIGSTOP');
		const failedIssue = await body<{ id: string }>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: 'Freeze a launch-time effort rejection'
			})
		);
		const assigned = await waitFor(async () => {
			const runs = await body<ListResponse<AgentRun>>(
				await api.get(`/api/v1/runs?issue=${failedIssue.id}`)
			);
			return runs.items.find((item) => item.status === 'assigned');
		});
		writeFileSync(probeFailureFile, 'fail');
		daemon?.kill('SIGCONT');
		const failed = await waitForEndedRun(async () => {
			const runs = await body<ListResponse<AgentRun>>(
				await api.get(`/api/v1/runs?issue=${failedIssue.id}`)
			);
			return runs.items;
		}, assigned.id);
		expect(failed.id).toBe(assigned.id);
		expect(failed.status).toBe('failed');
		expect(failed.requested_effort).toBe('ultra');
		expect(failed.resolved_effort).toBe('ultra');
		expect(failed.effort_application_status).toBe('rejected');
		expect(failed.effort_application_evidence).toMatchObject({
			milestones: [
				expect.objectContaining({
					status: 'rejected',
					attempted_effort: 'ultra',
					transport: 'argv'
				})
			]
		});
	} finally {
		await runCleanupSteps([
			{
				name: 'disable routed-effort automation',
				run: async () => {
					expect((await api.put('/api/v1/supervisor/settings', { enabled: false })).status()).toBe(
						200
					);
				}
			},
			{
				name: 'stop routed-effort daemon',
				run: async () => {
					if (daemon?.pid) daemon.kill('SIGKILL');
					daemon = null;
				}
			},
			...(ruleId
				? [
						{
							name: `delete routed-effort rule ${ruleId}`,
							run: async () => {
								expect((await api.delete(`/api/v1/routing-rules/${ruleId}`)).status()).toBe(204);
							}
						}
					]
				: []),
			...(projectId
				? [
						{
							name: `archive routed-effort project ${projectId}`,
							run: async () => {
								expect((await api.post(`/api/v1/projects/${projectId}/archive`)).status()).toBe(
									200
								);
							}
						}
					]
				: []),
			...(runnerId
				? [
						{
							name: `delete routed-effort runner ${runnerId}`,
							run: async () => {
								expect(
									(await api.delete(`/api/v1/runners/${runnerId}`, { force: true })).status()
								).toBe(204);
							}
						}
					]
				: []),
			{
				name: 'remove routed-effort temporary directory',
				run: async () => rmSync(root, { recursive: true, force: true })
			}
		]);
		if (output.includes('Error')) console.error(output);
	}
});

test('upgrades legacy delivery and applies wildcard fallback through the source daemon', async ({
	request,
	uniqueName
}) => {
	test.setTimeout(120_000);
	const api = apiClient(request, ALICE.apiKey);
	const root = mkdtempSync(join(tmpdir(), 'tines-effort-upgrade-e2e-'));
	const bin = join(root, 'bin');
	const config = join(root, 'config');
	const argvFile = join(root, 'argv.json');
	const legacyArgvFile = join(root, 'legacy-argv.json');
	const legacyWorkspace = join(root, 'legacy-workspace');
	mkdirSync(bin);
	mkdirSync(config);
	mkdirSync(legacyWorkspace);
	writeFileSync(
		join(bin, 'claude'),
		`#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') console.log('2.1.258 (Claude Code)');
else if (process.argv[2] === '--help') console.log('--effort <level>');
else {
  fs.writeFileSync(process.env.E2E_CODEX_ARGV, JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session_upgrade_e2e' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'session_upgrade_e2e' }));
}
`,
		{ mode: 0o755 }
	);
	const name = uniqueName('effort-upgrade');
	let runnerId: string | undefined;
	let oldRunnerId: string | undefined;
	let projectId: string | undefined;
	const ruleIds: string[] = [];
	let daemon: ChildProcess | null = null;
	try {
		const registered = await body<RunnerTokenResponse>(
			await api.post('/api/v1/runners/register', { name, harness: 'claude_code' })
		);
		runnerId = registered.runner.id;
		const model = registered.runner.tier_models?.balanced;
		expect(model).toBeTruthy();
		const capability = {
			version: 1 as const,
			daemon_version: 'e2e-new',
			harness: 'claude_code' as const,
			harness_version: '2.1.258 (Claude Code)',
			catalog_digest: 'upgrade-seed',
			models: [{ model: model!, efforts: ['max'] }]
		};
		const poll = (effort_capabilities?: typeof capability) =>
			request.post(`/api/v1/runners/${registered.runner.id}/poll`, {
				headers: { authorization: `Bearer ${registered.runner_token}` },
				data: {
					instance_id: 'legacy-boot',
					owned_runs: [],
					...(effort_capabilities ? { effort_capabilities } : {})
				}
			});
		expect((await poll(capability)).ok()).toBe(true);
		const tierSave = await api.patch(`/api/v1/runners/${registered.runner.id}`, {
			tiers: { balanced: { model, effort: 'max' } },
			resume_enabled: true
		});
		expect(tierSave.ok(), await tierSave.text()).toBe(true);
		// An old boot explicitly clears the new boot's promise. Tier-only intent
		// remains claimable, but the assignment deliberately omits effort.
		expect((await poll()).ok()).toBe(true);
		const project = await body<Project>(
			await api.post('/api/v1/projects', {
				// Projects containing run history can only be archived through the public API.
				// Keep their archived picker label inside the suite's 320 px envelope.
				name: uniqueName('effort-upgrade-project', { maxLength: 32 })
			})
		);
		projectId = project.id;
		expect((await api.put('/api/v1/supervisor/settings', { enabled: false })).ok()).toBe(true);
		const legacyIssue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: 'Do not resume legacy effort delivery'
			})
		);
		const issueDetail = legacyIssue;
		const concreteResponse = await api.post('/api/v1/routing-rules', {
			project_id: project.id,
			targets: [{ runner_id: registered.runner.id, tier: 'balanced' }]
		});
		expect(concreteResponse.ok()).toBe(true);
		const concrete = await body<RoutingRule>(concreteResponse);
		ruleIds.push(concrete.id);
		expect((await api.put('/api/v1/supervisor/settings', { enabled: true })).ok()).toBe(true);
		const legacy = await waitFor(async () => {
			const runs = await body<ListResponse<AgentRun>>(
				await api.get(`/api/v1/runs?issue=${legacyIssue.id}`)
			);
			return runs.items.find((item) => item.effort_application_status === 'legacy_not_applied');
		});
		expect(legacy.resolved_effort).toBe('max');
		expect(legacy.requested_effort).toBeNull();
		expect(legacy.status).toBe('assigned');

		// This is the old/no-capability daemon path: it receives the assignment,
		// launches a real child without an effort argument, advances the issue with
		// the delivered run key, and reports the resumable session and workspace.
		const deliveredResponse = await poll();
		expect(deliveredResponse.ok()).toBe(true);
		const delivered = await body<RunnerPollResponse>(deliveredResponse);
		const legacyAssignment = delivered.assignments.find((item) => item.run.id === legacy.id);
		expect(legacyAssignment).toBeDefined();
		expect(legacyAssignment?.effort).toBeUndefined();
		const legacyOutput = await new Promise<string>((resolve, reject) => {
			let output = '';
			const child = spawn(
				join(bin, 'claude'),
				['-p', '--output-format', 'stream-json', '--verbose', '--model', model!],
				{
					cwd: legacyWorkspace,
					env: { ...process.env, E2E_CODEX_ARGV: legacyArgvFile },
					stdio: ['ignore', 'pipe', 'pipe']
				}
			);
			child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
			child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
			child.on('error', reject);
			child.on('exit', (code) =>
				code === 0 ? resolve(output) : reject(new Error(`legacy harness exited ${code}: ${output}`))
			);
		});
		expect(JSON.parse(readFileSync(legacyArgvFile, 'utf8'))).not.toContain('--effort');
		const runnerHeaders = { authorization: `Bearer ${registered.runner_token}` };
		const logged = await request.post(`/api/v1/runs/${legacy.id}/logs`, {
			headers: runnerHeaders,
			data: { chunk: legacyOutput }
		});
		expect(logged.ok(), await logged.text()).toBe(true);
		const submitted = await apiClient(request, legacyAssignment!.run_key).post(
			`/api/v1/issues/${legacyIssue.id}/transition`,
			{ action: 'Submit for review' }
		);
		expect(submitted.ok(), await submitted.text()).toBe(true);
		const finishedResponse = await request.post(`/api/v1/runs/${legacy.id}/finish`, {
			headers: runnerHeaders,
			data: {
				status: 'completed',
				provider_session_id: 'session_upgrade_e2e',
				workspace_path: legacyWorkspace,
				turn_count: 1,
				conversation_turn_count: 1
			}
		});
		expect(finishedResponse.ok()).toBe(true);
		const finishedLegacy = await body<AgentRun>(finishedResponse);
		expect(finishedLegacy.status).toBe('completed');
		expect(finishedLegacy.effort_application_status).toBe('legacy_not_applied');
		expect(finishedLegacy.resume_expires_at).not.toBeNull();

		// Keep the claim-upgrade race separate: this one is intentionally assigned
		// under the old daemon and left undelivered for the new daemon to cancel.
		const raceIssue = await body<{ id: string }>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: 'Cancel an undelivered legacy effort claim'
			})
		);
		const legacyRace = await waitFor(async () => {
			const runs = await body<ListResponse<AgentRun>>(
				await api.get(`/api/v1/runs?issue=${raceIssue.id}`)
			);
			return runs.items.find((item) => item.effort_application_status === 'legacy_not_applied');
		});
		expect(legacyRace.status).toBe('assigned');

		writeFileSync(
			join(config, 'runners.json'),
			JSON.stringify({
				[`${BASE_URL}#${name}`]: {
					runner_id: registered.runner.id,
					token: registered.runner_token
				}
			})
		);
		daemon = spawn(
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
				'claude-code',
				'--poll-interval',
				'1',
				'--no-cli-refresh'
			],
			{
				cwd: CLI_DIR,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					TINES_CONFIG_DIR: config,
					E2E_CODEX_ARGV: argvFile
				},
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		const upgradedRace = await waitFor(async () => {
			const runs = await body<ListResponse<AgentRun>>(
				await api.get(`/api/v1/runs?issue=${raceIssue.id}`)
			);
			return runs.items.find((item) => item.status === 'completed');
		});
		expect(upgradedRace.id).not.toBe(legacyRace.id);
		expect(upgradedRace.resolved_effort).toBe('max');
		expect(upgradedRace.effort_application_status).toBe('accepted_unconfirmed');
		expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(
			expect.arrayContaining(['--effort', 'max'])
		);
		const frozenRace = await body<AgentRun>(await api.get(`/api/v1/runs/${legacyRace.id}`));
		expect(frozenRace.effort_application_status).toBe('legacy_not_applied');
		expect(frozenRace.status).toBe('canceled');

		// The completed legacy session is retained, but its fingerprint contains
		// no effort. Sending it back under enforced max must launch cold.
		const sentBack = await api.post(`/api/v1/issues/${legacyIssue.id}/transition`, {
			action: 'Send back'
		});
		expect(sentBack.ok(), await sentBack.text()).toBe(true);
		const upgraded = await waitFor(async () => {
			const runs = await body<ListResponse<AgentRun>>(
				await api.get(`/api/v1/runs?issue=${legacyIssue.id}`)
			);
			return runs.items.find((item) => item.id !== legacy.id && item.status === 'completed');
		});
		expect(upgraded.resolved_effort).toBe('max');
		expect(upgraded.effort_application_status).toBe('accepted_unconfirmed');
		expect(upgraded.resumed_from_run_id).toBeNull();
		expect(upgraded.resume_fallback_reason).toBe('incompatible');

		const old = await body<RunnerTokenResponse>(
			await api.post('/api/v1/runners/register', {
				name: uniqueName('effort-old'),
				harness: 'codex'
			})
		);
		oldRunnerId = old.runner.id;
		await request.post(`/api/v1/runners/${old.runner.id}/poll`, {
			headers: { authorization: `Bearer ${old.runner_token}` },
			data: { instance_id: 'old-boot', owned_runs: [] }
		});
		await api.patch(`/api/v1/routing-rules/${concrete.id}`, {
			targets: [
				{ runner_id: old.runner.id, tier: 'balanced' },
				{ runner_id: registered.runner.id, tier: 'balanced' }
			]
		});
		const wildcard = await body<RoutingRule>(
			await api.post('/api/v1/routing-rules', {
				project_id: project.id,
				workflow_state_id: issueDetail.state.id,
				targets: [{ runner_id: '*', tier: 'balanced', effort: 'max' }]
			})
		);
		ruleIds.push(wildcard.id);
		const fallbackIssue = await body<{ id: string }>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: 'Fall back from old daemon'
			})
		);
		const fallback = await waitFor(async () => {
			const runs = await body<ListResponse<AgentRun>>(
				await api.get(`/api/v1/runs?issue=${fallbackIssue.id}`)
			);
			return runs.items.find((item) => item.status === 'completed');
		});
		expect(fallback.runner_id).toBe(registered.runner.id);
		expect(fallback.requested_effort).toBe('max');
		expect(fallback.effort_source).toMatchObject({
			kind: 'routing_target',
			rule_id: wildcard.id
		});
	} finally {
		await runCleanupSteps([
			{
				name: 'disable effort-upgrade automation',
				run: async () => {
					expect((await api.put('/api/v1/supervisor/settings', { enabled: false })).status()).toBe(
						200
					);
				}
			},
			{
				name: 'stop effort-upgrade daemon',
				run: async () => {
					if (daemon?.pid) daemon.kill('SIGKILL');
					daemon = null;
				}
			},
			...ruleIds.reverse().map((id) => ({
				name: `delete effort-upgrade rule ${id}`,
				run: async () => {
					expect((await api.delete(`/api/v1/routing-rules/${id}`)).status()).toBe(204);
				}
			})),
			...(projectId
				? [
						{
							name: `archive effort-upgrade project ${projectId}`,
							run: async () => {
								expect((await api.post(`/api/v1/projects/${projectId}/archive`)).status()).toBe(
									200
								);
							}
						}
					]
				: []),
			...[oldRunnerId, runnerId]
				.filter((id): id is string => Boolean(id))
				.map((id) => ({
					name: `delete effort-upgrade runner ${id}`,
					run: async () => {
						expect((await api.delete(`/api/v1/runners/${id}`, { force: true })).status()).toBe(204);
					}
				})),
			{
				name: 'remove effort-upgrade temporary directory',
				run: async () => rmSync(root, { recursive: true, force: true })
			}
		]);
	}
});
