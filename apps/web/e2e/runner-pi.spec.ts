/**
 * The Pi harness end to end: a real `tines runner daemon --harness pi` with a
 * fake `pi` first on its PATH (the CLI's own test double, which answers
 * `--version`, serves the capability probe over RPC, and replays a recorded
 * `--mode json` stream). No model and nothing under `~/.pi`.
 *
 * What only the whole loop shows: the stream arrives as rendered log lines,
 * the summed token usage is recorded on the run, and a stream that ends in a
 * 429 fails the run without a strike even though `pi` exited 0.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	AgentRun,
	AgentRunDetail,
	IssueDetail,
	ListResponse,
	Project,
	Runner,
	WorkflowResponse
} from '@tines/shared';
import type { APIRequestContext } from '@playwright/test';
import { installFakePi } from '../../../packages/cli/src/test-fake-pi';
import { expect, test } from './fixtures';
import { BASE_URL, RUNNER_PI } from './constants.mjs';
import { apiClient, body, clickToOpen, gotoHydrated } from './helpers';

const CLI_DIR = fileURLToPath(new URL('../../../packages/cli', import.meta.url));
const TSX = join(CLI_DIR, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = join(CLI_DIR, 'src', 'index.ts');

const MODELS = [{ provider: 'mock', id: 'mock-think', levels: ['off', 'low', 'high'] }];
const USAGE = {
	input: 1034,
	output: 56,
	cacheRead: 200,
	cacheWrite: 0,
	totalTokens: 1290,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};
const ZERO_USAGE = { ...USAGE, input: 0, output: 0, cacheRead: 0, totalTokens: 0 };
const RATE_LIMITED =
	'429: {"message":"Rate limit reached: usage limit exceeded, try again later","type":"rate_limit_error"}';

function assistant(content: unknown[], fields: Record<string, unknown> = {}) {
	return {
		role: 'assistant',
		content,
		api: 'openai-completions',
		provider: 'mock',
		model: 'mock-think',
		usage: USAGE,
		stopReason: 'stop',
		thinkingLevel: 'high',
		...fields
	};
}

/** The recorded happy path, trimmed: text, one bash call, then DONE. */
function happyStream(): unknown[] {
	const args = { command: 'echo tines-probe-1' };
	const first = assistant(
		[
			{ type: 'text', text: 'Running it.' },
			{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: args }
		],
		{ stopReason: 'toolUse' }
	);
	const toolResult = {
		role: 'toolResult',
		toolCallId: 'call_1',
		toolName: 'bash',
		content: [{ type: 'text', text: 'tines-probe-1\n' }],
		isError: false
	};
	const last = assistant([{ type: 'text', text: 'DONE' }]);
	return [
		{ type: 'session', version: 3, id: '01a10335-d7b7-7690-aa36-7f04c20b8cb9' },
		{ type: 'agent_start' },
		{ type: 'turn_start' },
		{
			type: 'message_update',
			usage: USAGE,
			assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'PER-TOKEN-DELTA' }
		},
		{ type: 'message_end', message: first },
		{ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args },
		{
			type: 'tool_execution_end',
			toolCallId: 'call_1',
			toolName: 'bash',
			result: { structuredContent: { output: 'tines-probe-1\n', exit_code: 0 } },
			isError: false
		},
		{ type: 'message_end', message: toolResult },
		{ type: 'turn_end', message: first, toolResults: [toolResult] },
		{ type: 'turn_start' },
		{ type: 'message_end', message: last },
		{ type: 'turn_end', message: last, toolResults: [] },
		{ type: 'agent_end', messages: [first, toolResult, last], willRetry: false },
		{ type: 'agent_settled' }
	];
}

/** The recorded 429: the call fails, Pi retries once, it fails again — and Pi exits 0. */
function rateLimitedStream(): unknown[] {
	const failed = {
		...assistant([], { usage: ZERO_USAGE, stopReason: 'error', thinkingLevel: 'off' }),
		errorMessage: RATE_LIMITED
	};
	const attempt = [
		{ type: 'agent_start' },
		{ type: 'turn_start' },
		{ type: 'message_end', message: failed },
		{ type: 'turn_end', message: failed, toolResults: [] }
	];
	return [
		{ type: 'session', version: 3, id: '01a10336-82cf-7142-ab13-c50f6124ef49' },
		...attempt,
		{ type: 'agent_end', messages: [failed], willRetry: true },
		{
			type: 'auto_retry_start',
			attempt: 1,
			maxAttempts: 1,
			delayMs: 200,
			errorMessage: RATE_LIMITED
		},
		...attempt,
		{ type: 'agent_end', messages: [failed], willRetry: false },
		{ type: 'auto_retry_end', success: false, attempt: 1, finalError: RATE_LIMITED },
		{ type: 'agent_settled' }
	];
}

let e2eDir: string;
let daemon: ChildProcess | null = null;
let daemonOutput = '';
let daemonExited = false;
let runnerName: string;
let projectId: string;
let runner: Runner;

async function waitFor<T>(
	fn: () => Promise<T | undefined | false>,
	{ timeout = 30_000, interval = 250, label = 'condition' } = {}
): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await fn();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > deadline)
			throw new Error(`timed out waiting for ${label}\ndaemon output:\n${daemonOutput}`);
		await new Promise((r) => setTimeout(r, interval));
	}
}

async function issueRuns(request: APIRequestContext, issueId: string): Promise<AgentRun[]> {
	const api = apiClient(request, RUNNER_PI.apiKey);
	return (await body<ListResponse<AgentRun>>(await api.get(`/api/v1/runs?issue=${issueId}`))).items;
}

async function createIssue(request: APIRequestContext, title: string): Promise<IssueDetail> {
	const api = apiClient(request, RUNNER_PI.apiKey);
	const res = await api.post(`/api/v1/projects/${projectId}/issues`, { title });
	expect(res.status()).toBe(201);
	return body<IssueDetail>(res);
}

test.describe.serial('pi runner end to end', () => {
	test.beforeAll(async ({ request, uniqueName }) => {
		runnerName = uniqueName('e2e-pi');
		const api = apiClient(request, RUNNER_PI.apiKey);
		e2eDir = mkdtempSync(join(tmpdir(), 'tines-pi-e2e-'));
		const fakeBin = installFakePi(e2eDir, { models: MODELS, stream: happyStream() });

		const workflow = await body<WorkflowResponse>(
			await api.post('/api/v1/workflows', {
				name: uniqueName('pi-workflow'),
				initial_state: 'Open',
				states: [
					{ name: 'Open', category: 'active' },
					{ name: 'Human Review', category: 'awaiting_human' }
				],
				transitions: [{ name: 'Submit for review', from: 'Open', to: 'Human Review' }]
			})
		);
		projectId = (
			await body<Project>(
				await api.post('/api/v1/projects', {
					name: uniqueName('pi'),
					default_workflow_id: workflow.id
				})
			)
		).id;

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
				'pi',
				'--poll-interval',
				'1',
				// CI must not depend on the npm registry for the daemon-managed
				// agent CLI; the fake `pi` never runs `tines`.
				'--no-cli-refresh'
			],
			{
				cwd: CLI_DIR,
				env: {
					...process.env,
					PATH: `${fakeBin}:${process.env.PATH}`,
					TINES_API_KEY: RUNNER_PI.apiKey,
					TINES_CONFIG_DIR: join(e2eDir, 'config')
				},
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		daemon.stdout?.on('data', (d: Buffer) => (daemonOutput += d.toString()));
		daemon.stderr?.on('data', (d: Buffer) => (daemonOutput += d.toString()));
		daemon.on('exit', () => (daemonExited = true));
	});

	test.afterAll(async ({ request }) => {
		if (daemon && !daemonExited && daemon.pid) daemon.kill('SIGKILL');
		// Leave automation off for the specs that follow.
		const api = apiClient(request, RUNNER_PI.apiKey);
		await api.put('/api/v1/supervisor/settings', { enabled: false });
		rmSync(e2eDir, { recursive: true, force: true });
	});

	test('the daemon registers as a pi runner and reports the models pi lists', async ({
		request
	}) => {
		const api = apiClient(request, RUNNER_PI.apiKey);
		runner = await waitFor(
			async () => {
				const { items } = await body<ListResponse<Runner>>(await api.get('/api/v1/runners'));
				return items.find(
					(r) => r.name === runnerName && r.online && r.effort_capabilities !== null
				);
			},
			{ label: 'pi runner registration and capability report' }
		);
		expect(runner.type).toBe('local');
		expect(runner.config.harness).toBe('pi');
		// No built-in tier table, but tiers still apply: the owner names the models.
		expect(runner.tier_models).toBeNull();
		expect(runner.tiers_apply).toBe(true);
		expect(runner.effort_capabilities).toMatchObject({
			harness: 'pi',
			models: [{ model: 'mock/mock-think', efforts: ['low', 'high'] }]
		});

		// Route only this project to it, then arm automation.
		const rule = await api.post('/api/v1/routing-rules', {
			project_id: projectId,
			targets: [{ runner_id: runner.id }]
		});
		expect(rule.status()).toBe(201);
		expect((await api.put('/api/v1/supervisor/settings', { enabled: true })).ok()).toBe(true);
	});

	test('a pi run streams rendered log lines and records the tokens the model server reported', async ({
		request
	}) => {
		test.setTimeout(90_000);
		const api = apiClient(request, RUNNER_PI.apiKey);
		const issue = await createIssue(request, 'Pi works this');

		const run = await waitFor(
			async () => (await issueRuns(request, issue.id)).find((r) => r.status === 'completed'),
			{ timeout: 45_000, label: 'the pi run to complete' }
		);
		expect(run.runner_name).toBe(runnerName);
		expect(run.model).toBeNull(); // no tier override: Pi's own default
		// Two assistant messages, summed. Tokens without a cost: nothing is priced.
		expect(run.usage).toMatchObject({
			input_tokens: 2068,
			output_tokens: 112,
			cache_read_tokens: 400
		});
		expect(run.usage?.cost_usd).toBeUndefined();
		expect(run.usage?.cost_source).toBeUndefined();

		const log = await (await api.get(`/api/v1/runs/${run.id}/log`)).text();
		const lines = [
			'[session] started',
			'[session] model mock/mock-think thinking=high',
			'[agent] Running it.',
			'[tool] bash: echo tines-probe-1',
			'[agent] DONE'
		];
		for (const line of lines) expect(log).toContain(line);
		expect(lines.map((line) => log.indexOf(line))).toEqual(
			lines.map((line) => log.indexOf(line)).sort((a, b) => a - b)
		);
		// Rendered, not the raw stream: no JSON events and no per-token deltas.
		expect(log).not.toContain('"type":"message_end"');
		expect(log).not.toContain('PER-TOKEN-DELTA');

		// The raw stream is kept beside it, without the per-token updates.
		const raw = await (await api.get(`/api/v1/runs/${run.id}/log?raw=1`)).text();
		expect(raw).toContain('"type":"message_end"');
		expect(raw).not.toContain('PER-TOKEN-DELTA');

		// The fake never moves the issue, so the run stalled and would be
		// retried. Hand the issue to a human and let any retry settle before the
		// next test swaps the stream under the same binary.
		const moved = await api.post(`/api/v1/issues/${issue.id}/transition`, {
			action: 'Submit for review'
		});
		expect(moved.ok(), await moved.text()).toBe(true);
		await waitFor(
			async () =>
				(await issueRuns(request, issue.id)).every(
					(r) => !['assigned', 'launching', 'running'].includes(r.status)
				),
			{ label: 'the first issue to have no run in flight' }
		);
	});

	test('a stream that ends in a 429 fails the run without a strike, though pi exited 0', async ({
		request
	}) => {
		test.setTimeout(90_000);
		const api = apiClient(request, RUNNER_PI.apiKey);
		installFakePi(e2eDir, { models: MODELS, stream: rateLimitedStream() });
		const issue = await createIssue(request, 'Pi hits the limit');

		const run = await waitFor(
			async () => (await issueRuns(request, issue.id)).find((r) => r.status === 'failed'),
			{ timeout: 45_000, label: 'the rate-limited pi run to fail' }
		);
		expect(run.error).toContain('rate limited: 429');
		expect(run.outcome).toBe('interrupted');

		const detail = await body<AgentRunDetail>(await api.get(`/api/v1/runs/${run.id}`));
		expect(detail.log).toContain('[retry] attempt 1/1: 429');
		expect(detail.log).toContain('[error] 429');

		// No strike against the issue, and the runner backs off instead.
		const after = await body<IssueDetail>(await api.get(`/api/v1/issues/${issue.id}`));
		expect(after.attempt_count).toBe(0);
		expect(after.needs_attention).toBe(false);
		const { items } = await body<ListResponse<Runner>>(await api.get('/api/v1/runners'));
		const limited = items.find((r) => r.id === runner.id);
		expect(limited?.backoff_reason).toBe('rate_limit');
		expect(limited?.backoff_until).not.toBeNull();
	});

	test.describe('runner page', () => {
		test.use({ signedIn: RUNNER_PI });

		test("a pi runner's edit dialog shows the tier editor, with pi's models to pick from", async ({
			page
		}) => {
			await gotoHydrated(page, '/agents#runners');
			const card = page.locator(`#runner-${runner.id}`);
			await expect(card).toBeVisible();
			const dialog = page.getByRole('dialog', { name: 'Edit runner' });
			await clickToOpen(card.getByRole('button', { name: 'Edit' }), dialog);

			await expect(dialog.locator('#edit-default-tier')).toBeEnabled();
			const model = dialog.locator('#edit-model-balanced');
			await expect(model).toBeVisible();
			await expect(model).toHaveAttribute('placeholder', "Pi's default model");
			const list = await model.getAttribute('list');
			expect(list).toBeTruthy();
			await expect(dialog.locator(`datalist#${list} option`)).toHaveCount(1);
			await expect(dialog.locator(`datalist#${list} option`)).toHaveAttribute(
				'value',
				'mock/mock-think'
			);
		});
	});
});
