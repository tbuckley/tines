/**
 * Final workflow-package acceptance: a browser session installs one exact
 * package, then a real local-runner daemon works an issue in the installed
 * workflow and satisfies its artifact-gated Handoff transition.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	canonicalizeLibraryValue,
	type AgentRun,
	type AgentRunDetail,
	type ArtifactListResponse,
	type CreateIssueResponse,
	type IssueDetail,
	type ListResponse,
	type PrepareWorkflowPackageResponse,
	type Project,
	type Runner,
	type WorkflowPackageDocument,
	type WorkflowPackageReceipt,
	type WorkflowResponse
} from '@tines/shared';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE, BASE_URL } from './constants.mjs';
import { apiClient, body, gotoHydrated, runId, signIn } from './helpers';

const CLI_DIR = fileURLToPath(new URL('../../../packages/cli', import.meta.url));
const TSX = join(CLI_DIR, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = join(CLI_DIR, 'src', 'index.ts');

async function waitFor<T>(
	fn: () => Promise<T | undefined | false>,
	{ timeout = 45_000, interval = 250, label = 'condition', output = () => '' } = {}
): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await fn();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > deadline)
			throw new Error(`timed out waiting for ${label}\ndaemon output:\n${output()}`);
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
}

async function issueRuns(request: APIRequestContext, issueId: string) {
	const api = apiClient(request, ALICE.apiKey);
	return (await body<ListResponse<AgentRun>>(await api.get(`/api/v1/runs?issue=${issueId}`))).items;
}

test('installs as Alice and activates the installed Run state through a real daemon', async ({
	context,
	page,
	request
}, testInfo) => {
	test.setTimeout(180_000);
	const marker = `Tines/445 isolated destination ${runId}`;
	const workflowName = `Package runner source ${runId}`;
	const installedName = `Package runner installed ${runId}`;
	const runnerName = `package-acceptance-runner-${runId}`;
	const api = apiClient(request, ALICE.apiKey);
	let daemon: ChildProcess | null = null;
	let daemonOutput = '';
	let daemonExited = false;
	const acceptanceDir = mkdtempSync(join(tmpdir(), 'tines-package-runner-acceptance-'));
	const configDir = join(acceptanceDir, 'config');
	mkdirSync(configDir, { recursive: true });

	try {
		const source = await body<WorkflowResponse>(
			await api.post('/api/v1/workflows', {
				name: workflowName,
				description: 'A bounded installed-package runner acceptance workflow.',
				initial_state: 'Run',
				states: [
					{ name: 'Run', category: 'active' },
					{ name: 'Handoff', category: 'awaiting_human' }
				],
				transitions: [
					{
						name: 'Handoff',
						from: 'Run',
						to: 'Handoff',
						requires: [
							{
								artifact: 'acceptance-evidence',
								type: 'text',
								content_type: 'text/markdown'
							}
						]
					}
				]
			})
		);
		const sourceRun = source.states.find((state) => state.name === 'Run')!;
		await body(
			await api.post('/api/v1/context', {
				kind: 'prompt',
				name: 'destination-proof',
				workflow_state_id: sourceRun.id,
				body: 'Resolved destination marker: {{destination_marker:SOURCE}}'
			})
		);
		await body(
			await api.post('/api/v1/context', {
				kind: 'skill',
				name: 'acceptance-handoff',
				workflow_state_id: sourceRun.id,
				files: [
					{
						path: 'SKILL.md',
						content: '# Acceptance handoff\n\nAttach `acceptance-evidence`, then take `Handoff`.\n'
					}
				]
			})
		);
		const destination = await body<Project>(
			await api.post('/api/v1/projects', { name: `Package runner destination ${runId}` })
		);
		const defaultBefore = destination.default_workflow_id;

		const authoring = {
			inputs: [
				{
					id: 'input:destination-marker',
					key: 'destination_marker',
					type: 'text',
					label: 'Destination marker',
					description: 'Exact marker expected in the installed launch context',
					required: true,
					default: 'SOURCE'
				}
			],
			text_uses: [
				{
					id: 'use:destination-marker',
					target: { record_id: 'context:1', field: 'body' },
					input_id: 'input:destination-marker',
					token: '{{destination_marker:SOURCE}}'
				}
			]
		};
		const document = await body<WorkflowPackageDocument>(
			await api.get(
				`/api/v1/workflows/${source.id}/export?authoring=${encodeURIComponent(JSON.stringify(authoring))}`
			)
		);
		const documentJson = `${canonicalizeLibraryValue(document)}\n`;
		const packagePath = join(acceptanceDir, 'bounded-package.json');
		writeFileSync(packagePath, documentJson);

		await signIn(context, ALICE.sessionToken);
		await gotoHydrated(page, '/workflows/import');
		await page.getByLabel('Workflow package file').setInputFiles(packagePath);
		await page.getByLabel('Destination marker').fill(marker);
		await page.getByLabel(`Main · ${workflowName}`).fill(installedName);
		const prepareResponse = page.waitForResponse(
			(response) =>
				response.url().endsWith('/api/v1/library/prepare') &&
				response.request().method() === 'POST' &&
				response.ok()
		);
		await page.getByRole('button', { name: 'Prepare installation' }).click();
		const plan = (await (await prepareResponse).json()) as PrepareWorkflowPackageResponse;
		expect(plan.actor_key).toBe(`session:${ALICE.id}`);
		expect(plan.document_digest).toBe(document.digest);
		for (const checkbox of await page.getByRole('checkbox', { name: /I reviewed/ }).all())
			await checkbox.check();
		await page.getByRole('checkbox', { name: /I confirm exact plan/ }).check();
		const installResponse = page.waitForResponse(
			(response) =>
				response.url().endsWith('/api/v1/library/install') &&
				response.request().method() === 'POST' &&
				response.ok()
		);
		await page.getByRole('button', { name: 'Install package' }).click();
		const receipt = (await (await installResponse).json()) as WorkflowPackageReceipt;
		await expect(
			page.getByRole('heading', { name: 'Package installed', exact: true })
		).toBeFocused();
		expect(receipt.document_digest).toBe(document.digest);
		expect(receipt.plan_digest).toBe(plan.plan_digest);
		const installedWorkflowId = receipt.objects.find(
			(object) => object.kind === 'workflow' && object.relationship === 'main'
		)!.id;
		const installed = await body<WorkflowResponse>(
			await api.get(`/api/v1/workflows/${installedWorkflowId}`)
		);
		const installedRun = installed.states.find((state) => state.name === 'Run')!;
		const noIssues = await body<ListResponse<IssueDetail>>(
			await api.get(`/api/v1/issues?project=${destination.id}`)
		);
		expect(noIssues.items).toEqual([]);
		expect(
			(await body<Project>(await api.get(`/api/v1/projects/${destination.id}`))).default_workflow_id
		).toBe(defaultBefore);

		const evidenceText = `# Isolated-stack acceptance evidence\n\nResolved destination marker: ${marker}\n`;
		writeFileSync(join(acceptanceDir, 'acceptance-evidence.md'), evidenceText);
		const harnessPath = join(acceptanceDir, 'harness.sh');
		writeFileSync(
			harnessPath,
			`#!/usr/bin/env bash
set -euo pipefail
cp prompt.md "$ACCEPTANCE_DIR/launch-prompt.md"
REF=$(sed -n 's/^This is run .* for issue \\([^;]*\\);.*/\\1/p' prompt.md | head -n 1)
echo "isolated acceptance harness start ref=$REF"
${TSX} ${CLI_ENTRY} issues artifacts attach "$REF" acceptance-evidence --text "@$ACCEPTANCE_DIR/acceptance-evidence.md"
${TSX} ${CLI_ENTRY} issues move "$REF" Handoff
echo "isolated acceptance harness complete marker=$DESTINATION_MARKER"
`,
			{ mode: 0o755 }
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
				runnerName,
				'--harness',
				'custom',
				'--command',
				`bash "${harnessPath}"`,
				'--poll-interval',
				'1',
				'--no-cli-refresh'
			],
			{
				cwd: CLI_DIR,
				env: {
					...process.env,
					TINES_API_KEY: ALICE.apiKey,
					TINES_CONFIG_DIR: configDir,
					ACCEPTANCE_DIR: acceptanceDir,
					DESTINATION_MARKER: marker
				},
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		daemon.stdout?.on('data', (chunk: Buffer) => (daemonOutput += chunk.toString()));
		daemon.stderr?.on('data', (chunk: Buffer) => (daemonOutput += chunk.toString()));
		daemon.on('exit', () => (daemonExited = true));
		const runner = await waitFor(
			async () => {
				const { items } = await body<ListResponse<Runner>>(await api.get('/api/v1/runners'));
				return items.find((item) => item.name === runnerName && item.online);
			},
			{ label: 'the acceptance runner to register', output: () => daemonOutput }
		);
		await body(
			await api.post('/api/v1/routing-rules', {
				project_id: destination.id,
				targets: [{ runner_id: runner.id }]
			})
		);
		await body(await api.put('/api/v1/supervisor/settings', { enabled: true }));

		const issue = await body<CreateIssueResponse>(
			await api.post(`/api/v1/projects/${destination.id}/issues`, {
				title: `Bounded installed-package activation ${runId}`,
				description: 'One benign local runner activation after browser installation.',
				workflow_id: installed.id,
				state: installedRun.id
			})
		);
		const run = await waitFor(
			async () => (await issueRuns(request, issue.id)).find((item) => item.status === 'completed'),
			{
				timeout: 60_000,
				label: 'the installed workflow run to complete',
				output: () => daemonOutput
			}
		);
		const detail = await body<AgentRunDetail>(await api.get(`/api/v1/runs/${run.id}`));
		const finishedIssue = await body<IssueDetail>(await api.get(`/api/v1/issues/${issue.id}`));
		const artifacts = await body<ArtifactListResponse>(
			await api.get(`/api/v1/issues/${issue.id}/artifacts`)
		);
		const evidenceArtifact = artifacts.items.find((item) => item.name === 'acceptance-evidence')!;
		const contentResponse = await request.get(
			`${BASE_URL}/api/v1/issues/${issue.id}/artifacts/acceptance-evidence/content`,
			{ headers: { authorization: `Bearer ${ALICE.apiKey}` } }
		);
		expect(contentResponse.ok()).toBe(true);
		expect(await contentResponse.text()).toBe(evidenceText);
		expect(readFileSync(join(acceptanceDir, 'launch-prompt.md'), 'utf8')).toContain(marker);
		expect(finishedIssue.state.name).toBe('Handoff');
		expect(run.runner_id).toBe(runner.id);
		expect(run.outcome).toBe('advanced');
		expect(run.state_id_at_start).toBe(installedRun.id);
		expect(run.state_at_end_name).toBe('Handoff');
		expect(detail.log).toContain('isolated acceptance harness start');
		expect(detail.log).toContain(`isolated acceptance harness complete marker=${marker}`);
		expect(evidenceArtifact.current_version.actor.run?.run_id).toBe(run.id);

		const evidence = {
			evidence_kind: 'isolated-stack actual-run evidence',
			server: BASE_URL,
			installing_actor: { user_id: ALICE.id, actor_key: plan.actor_key },
			project: { id: destination.id, name: destination.name },
			package: { file_digest: document.digest, plan_digest: plan.plan_digest },
			receipt: { id: receipt.id, objects: receipt.objects },
			issue: { id: issue.id, ref: `${issue.project_name}/${issue.number}` },
			runner: { id: runner.id, name: runner.name },
			run: {
				id: run.id,
				status: run.status,
				outcome: run.outcome,
				log_full_bytes: detail.log_full_bytes,
				log_markers: ['isolated acceptance harness start', 'isolated acceptance harness complete']
			},
			launch_context: { marker, installed_state_id: installedRun.id },
			artifact: {
				id: evidenceArtifact.id,
				name: evidenceArtifact.name,
				version: evidenceArtifact.current_version.version,
				content: evidenceText
			},
			final_state: finishedIssue.state.name
		};
		const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
		writeFileSync(testInfo.outputPath('isolated-stack-evidence.json'), serialized);
		await testInfo.attach('isolated-stack-evidence', {
			body: Buffer.from(serialized),
			contentType: 'application/json'
		});
		console.log(`TINES_445_ISOLATED_STACK_EVIDENCE=${JSON.stringify(evidence)}`);
	} finally {
		await api.put('/api/v1/supervisor/settings', { enabled: false });
		if (daemon && !daemonExited && daemon.pid) daemon.kill('SIGKILL');
		rmSync(acceptanceDir, { recursive: true, force: true });
	}
});
