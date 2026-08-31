/**
 * The real local-runner loop, end to end: a `tines runner daemon --harness
 * custom` process (via tsx, no build step) pointed at a script harness,
 * driven by the API's opportunistic dispatch passes and `--test-scheduled`
 * sweeps. The harness's behavior is switched per test through a mode file:
 * `work` comments + transitions via the CLI with the delivered run key,
 * `noop` exits silently (the strike path), `sleep` blocks (the cancel path).
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	AgentRun,
	AgentRunDetail,
	Comment,
	IssueDetail,
	ListResponse,
	Project,
	Runner,
	TinesEvent
} from '@tines/shared';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { ALICE, BASE_URL } from './constants.mjs';
import { apiClient, body, runId, signIn } from './helpers';

const CLI_DIR = fileURLToPath(new URL('../../../packages/cli', import.meta.url));
const TSX = join(CLI_DIR, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = join(CLI_DIR, 'src', 'index.ts');

const RUNNER_NAME = `e2e-runner-${runId}`;
const PROJECT_NAME = `runner-${runId}`;

// Shared across the serial suite.
let e2eDir: string;
let configDir: string;
let srcRepoDir: string;
let harnessPath: string;
let daemon: ChildProcess | null = null;
let daemonOutput = '';
let daemonExited = false;
let projectId: string;
let runnerId: string;

const setMode = (mode: 'work' | 'noop' | 'sleep' | 'flood') => writeFileSync(join(e2eDir, 'mode'), mode);

const sideFile = (name: string) => join(e2eDir, name);
const readSideFile = (name: string) => readFileSync(sideFile(name), 'utf8');

async function waitFor<T>(
	fn: () => Promise<T | undefined | false>,
	{ timeout = 30_000, interval = 250, label = 'condition' } = {}
): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await fn();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\ndaemon output:\n${daemonOutput}`);
		await new Promise((r) => setTimeout(r, interval));
	}
}

const fireSweep = async (request: APIRequestContext) => {
	const res = await request.get('/__scheduled?cron=*+*+*+*+*');
	expect(res.ok()).toBe(true);
};

async function issueRuns(request: APIRequestContext, issueId: string): Promise<AgentRun[]> {
	const api = apiClient(request, ALICE.apiKey);
	return (await body<ListResponse<AgentRun>>(await api.get(`/api/v1/runs?issue=${issueId}`))).items;
}

async function createIssue(request: APIRequestContext, title: string): Promise<IssueDetail> {
	const api = apiClient(request, ALICE.apiKey);
	const res = await api.post(`/api/v1/projects/${projectId}/issues`, { title });
	expect(res.status()).toBe(201);
	return body<IssueDetail>(res);
}

test.describe.serial('local runner end to end', () => {
	test.beforeAll(async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		e2eDir = mkdtempSync(join(tmpdir(), 'tines-runner-e2e-'));
		configDir = join(e2eDir, 'config');
		mkdirSync(configDir, { recursive: true });
		setMode('work');

		// A local git repository the workspace clone pulls from.
		srcRepoDir = join(e2eDir, 'srcrepo');
		mkdirSync(srcRepoDir);
		execSync('git init -q -b main .', { cwd: srcRepoDir });
		writeFileSync(join(srcRepoDir, 'hello.txt'), 'cloned payload\n');
		execSync(
			'git -c user.email=e2e@test -c user.name=e2e add hello.txt && git -c user.email=e2e@test -c user.name=e2e commit -q -m init',
			{ cwd: srcRepoDir, shell: '/bin/bash' }
		);

		// The script harness, mode-switched through $E2E_DIR/mode.
		harnessPath = join(e2eDir, 'harness.sh');
		writeFileSync(
			harnessPath,
			`#!/usr/bin/env bash
set -euo pipefail
MODE=$(cat "$E2E_DIR/mode" 2>/dev/null || echo noop)
echo "harness start mode=$MODE pid=$$"
case "$MODE" in
	work)
		cp prompt.md "$E2E_DIR/last-prompt.md"
		cp repos.json "$E2E_DIR/last-repos.json"
		find skills -type f > "$E2E_DIR/last-skills.txt"
		cat srcrepo/hello.txt > "$E2E_DIR/clone-proof.txt"
		printf '%s' "$TINES_API_KEY" > "$E2E_DIR/last-key"
		REF=$(sed -n 's/^This is run .* for issue \\([^;]*\\);.*/\\1/p' prompt.md | head -n 1)
		${TSX} ${CLI_ENTRY} issues comment "$REF" "Harness progress comment"
		${TSX} ${CLI_ENTRY} issues move "$REF" "Submit for review"
		echo "harness done"
		;;
	sleep)
		echo $$ > "$E2E_DIR/sleep-pid"
		sleep 300
		;;
	flood)
		# ~600 KB, well past the 256 KB tail cap, with the first and last
		# lines marked so a full-log read can prove nothing scrolled off.
		echo "FLOOD-FIRST-LINE"
		for i in $(seq 1 6000); do
			printf 'flood line %05d %s\\n' "$i" "..............................................................................................."
		done
		echo "FLOOD-LAST-LINE"
		REF=$(sed -n 's/^This is run .* for issue \\([^;]*\\);.*/\\1/p' prompt.md | head -n 1)
		${TSX} ${CLI_ENTRY} issues move "$REF" "Submit for review"
		;;
	noop)
		;;
esac
`,
			{ mode: 0o755 }
		);

		// Project + context the workspace should materialize.
		projectId = (
			await body<Project>(
				await api.post('/api/v1/projects', {
					name: PROJECT_NAME,
					initial_prompt: 'E2E conventions: be excellent to each other.'
				})
			)
		).id;
		await api.post('/api/v1/context', {
			kind: 'skill',
			name: 'e2e-skill',
			project_id: projectId,
			files: [{ path: 'notes.md', content: 'skill payload\n' }]
		});
		await api.post('/api/v1/context', {
			kind: 'repo',
			name: 'e2e-repo',
			project_id: projectId,
			repo_url: `file://${srcRepoDir}`
		});

		// The daemon: 1s polls, custom script harness, isolated config dir.
		daemon = spawn(
			TSX,
			[
				CLI_ENTRY,
				'runner',
				'daemon',
				'--url',
				BASE_URL,
				'--name',
				RUNNER_NAME,
				'--harness',
				'custom',
				'--command',
				`bash "${harnessPath}"`,
				'--poll-interval',
				'1'
			],
			{
				cwd: CLI_DIR,
				env: { ...process.env, TINES_API_KEY: ALICE.apiKey, TINES_CONFIG_DIR: configDir, E2E_DIR: e2eDir },
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		daemon.stdout?.on('data', (d: Buffer) => (daemonOutput += d.toString()));
		daemon.stderr?.on('data', (d: Buffer) => (daemonOutput += d.toString()));
		daemon.on('exit', () => (daemonExited = true));
	});

	test.afterAll(async ({ request }) => {
		if (daemon && !daemonExited && daemon.pid) {
			daemon.kill('SIGKILL');
		}
		// Leave automation off for the specs that follow.
		const api = apiClient(request, ALICE.apiKey);
		await api.put('/api/v1/supervisor/settings', { enabled: false });
		rmSync(e2eDir, { recursive: true, force: true });
	});

	test('the daemon registers and the runner shows up online', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const runner = await waitFor(
			async () => {
				const { items } = await body<ListResponse<Runner>>(await api.get('/api/v1/runners'));
				return items.find((r) => r.name === RUNNER_NAME && r.online);
			},
			{ label: 'runner registration' }
		);
		runnerId = runner.id;
		expect(runner.type).toBe('local');
		expect(runner.config.harness).toBe('custom');
		expect(runner.config.hostname).toBeTruthy();

		// Route only this project to it (a global rule would grab other specs'
		// issues), then arm automation.
		const rule = await api.post('/api/v1/routing-rules', {
			project_id: projectId,
			targets: [{ runner_id: runnerId }]
		});
		expect(rule.status()).toBe(201);
		const settings = await api.put('/api/v1/supervisor/settings', { enabled: true });
		expect(settings.ok()).toBe(true);
	});

	test('an issue moved into an active state is worked within a poll: workspace, attribution, key lifecycle', async ({
		request
	}) => {
		test.setTimeout(60_000);
		const api = apiClient(request, ALICE.apiKey);
		setMode('work');
		const issue = await createIssue(request, 'Work me');

		const run = await waitFor(
			async () => (await issueRuns(request, issue.id)).find((r) => r.status === 'completed'),
			{ timeout: 45_000, label: 'the run to complete' }
		);
		expect(run.runner_name).toBe(RUNNER_NAME);
		expect(run.tier).toBe('balanced');
		expect(run.model).toBeNull(); // a custom harness cannot vary its model

		// The workspace the harness saw: preamble + stitched context + issue
		// block in prompt.md, the skill files, repos.json, and the clone.
		const prompt = readSideFile('last-prompt.md');
		expect(prompt).toContain('# Supervisor run');
		expect(prompt).toContain(`on runner "${RUNNER_NAME}"`);
		expect(prompt).toContain('E2E conventions: be excellent');
		expect(prompt).toContain('## Issue: ');
		expect(prompt).toContain('Submit for review');
		expect(readSideFile('last-skills.txt')).toContain('skills/e2e-skill/notes.md');
		expect(readSideFile('last-repos.json')).toContain(`file://${srcRepoDir}`);
		expect(readSideFile('clone-proof.txt')).toBe('cloned payload\n');

		// The agent's comment and transition are attributed "via <runner> · run …".
		const detail = await body<IssueDetail>(await api.get(`/api/v1/issues/${issue.id}`));
		expect(detail.state.name).toBe('Human Review');
		const comment = detail.comments.find((c: Comment) => c.body === 'Harness progress comment');
		expect(comment).toBeDefined();
		expect(comment!.actor.run?.run_id).toBe(run.id);
		expect(comment!.actor.run?.runner_name).toBe(RUNNER_NAME);

		// The run advanced the issue (its own key transitioned it)…
		const ended = await body<ListResponse<TinesEvent>>(
			await api.get(`/api/v1/events?issue=${issue.id}&type=agent_run.ended`)
		);
		expect(ended.items[0].payload.outcome).toBe('advanced');
		expect(detail.attempt_count).toBe(0);

		// …and its key was revoked the moment the finish was reported.
		const runKey = readSideFile('last-key');
		expect(runKey).toMatch(/^tines_/);
		const reuse = await apiClient(request, runKey).get('/api/v1/issues');
		expect(reuse.status()).toBe(401);
	});

	test('the log tail captured the harness output', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const { items } = await body<ListResponse<AgentRun>>(
			await api.get(`/api/v1/runs?runner=${runnerId}`)
		);
		const completed = items.find((r) => r.status === 'completed');
		expect(completed).toBeDefined();
		const detail = await body<AgentRunDetail>(await api.get(`/api/v1/runs/${completed!.id}`));
		expect(detail.log).toContain('harness start mode=work');
		expect(detail.log).toContain('harness done');
		expect(detail.log_bytes_dropped).toBe(0);
	});

	test('an oversized log keeps every byte: the tail truncates, the full log does not', async ({
		request
	}) => {
		test.setTimeout(120_000);
		const api = apiClient(request, ALICE.apiKey);
		setMode('flood');
		const issue = await createIssue(request, 'Flood the log');

		const run = await waitFor(
			async () => {
				const runs = await issueRuns(request, issue.id);
				return runs.find((r) => r.status === 'completed');
			},
			{ timeout: 90_000, interval: 1000, label: 'the flooding run to finish' }
		);
		// endRun seals inline, but the sweep is the guarantee — fire it so the
		// assertions below hold whichever path did the sealing.
		await fireSweep(request);

		const detail = await body<AgentRunDetail>(await api.get(`/api/v1/runs/${run.id}`));
		// The tail behaves exactly as it always did: capped, head-truncated.
		expect(detail.log_bytes_dropped).toBeGreaterThan(0);
		expect(detail.log).not.toContain('FLOOD-FIRST-LINE');
		expect(detail.log).toContain('FLOOD-LAST-LINE');
		expect(detail.log_full_bytes).toBeGreaterThan(new TextEncoder().encode(detail.log).length);
		expect(detail.log_expired).toBe(false);

		// …and the full log has the bytes the tail dropped, in order.
		const res = await api.get(`/api/v1/runs/${run.id}/log`);
		expect(res.status()).toBe(200);
		const full = await res.text();
		expect(full).toContain('FLOOD-FIRST-LINE');
		expect(full).toContain('FLOOD-LAST-LINE');
		expect(full.indexOf('flood line 00001')).toBeLessThan(full.indexOf('flood line 06000'));
		expect(full.endsWith(detail.log)).toBe(true);
		expect(new TextEncoder().encode(full).length).toBe(detail.log_full_bytes);

		setMode('work');
	});

	test('the Agents tab shows the runner online, the log viewer, and the bootstrap wizard', async ({
		context,
		page
	}) => {
		await signIn(context, ALICE.sessionToken);
		await page.goto('/agents');

		// The daemon-registered runner card, online, with the rotate action.
		const card = page.locator('div.rounded-lg', { hasText: RUNNER_NAME }).first();
		await expect(card.getByText('online')).toBeVisible();
		await expect(card.getByRole('button', { name: 'Rotate token' })).toBeVisible();

		// The completed run's row expands to the captured log tail.
		await page.getByLabel('Show ended runs').check();
		const row = page.locator('li', { hasText: RUNNER_NAME }).filter({ hasText: 'completed' }).first();
		await row.getByRole('button', { name: 'Logs', exact: true }).click();
		await expect(page.getByTestId('run-log').first()).toContainText('harness start mode=work');

		// The add-runner wizard: the local path is the copy-pasteable daemon
		// bootstrap (the Claude managed path creates the runner server-side).
		await page.getByRole('button', { name: 'Add runner' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add runner' });
		await dialog.getByLabel('Name').fill('laptop-e2e');
		await expect(dialog).toContainText('tines runner daemon');
		await expect(dialog).toContainText('--name laptop-e2e');
		await expect(dialog).toContainText('registers');
		await expect(dialog).toContainText('launchd/systemd');
		await dialog.getByRole('button', { name: 'Done' }).click();
	});

	test('a do-nothing harness strikes the issue three times and parks it', async ({ request }) => {
		test.setTimeout(90_000);
		const api = apiClient(request, ALICE.apiKey);
		setMode('noop');
		const issue = await createIssue(request, 'Nothing happens');

		// Each finish frees the claim and requeues the issue; the sweep is the
		// belt to the opportunistic braces.
		const parked = await waitFor(
			async () => {
				await fireSweep(request);
				const detail = await body<IssueDetail>(await api.get(`/api/v1/issues/${issue.id}`));
				return detail.needs_attention ? detail : undefined;
			},
			{ timeout: 75_000, interval: 1000, label: 'the issue to park' }
		);
		expect(parked.attempt_count).toBeGreaterThanOrEqual(3);
		const runs = await issueRuns(request, issue.id);
		expect(runs.filter((r) => r.status === 'completed').length).toBeGreaterThanOrEqual(3);

		const events = await body<ListResponse<TinesEvent>>(
			await api.get(`/api/v1/events?issue=${issue.id}&type=issue.parked`)
		);
		expect(events.items.length).toBeGreaterThanOrEqual(1);

		// Resume clears the park and resets the count — and redispatches, so
		// switch the harness back to work mode first and wait for that run to
		// hand the issue off before the next test repurposes the mode file.
		setMode('work');
		const resumed = await body<IssueDetail>(await api.post(`/api/v1/issues/${issue.id}/resume`));
		expect(resumed.needs_attention).toBe(false);
		expect(resumed.attempt_count).toBe(0);
		await waitFor(
			async () => {
				const detail = await body<IssueDetail>(await api.get(`/api/v1/issues/${issue.id}`));
				return detail.state.name === 'Human Review' ? detail : undefined;
			},
			{ timeout: 45_000, label: 'the resumed issue to be worked and handed off' }
		);
	});

	test('cancel mid-run (via the dialog, comment first) kills the harness process without a finish report', async ({
		request,
		context,
		page
	}) => {
		test.setTimeout(60_000);
		const api = apiClient(request, ALICE.apiKey);
		rmSync(sideFile('sleep-pid'), { force: true });
		setMode('sleep');
		const issue = await createIssue(request, 'Cancel me');

		const running = await waitFor(
			async () => (await issueRuns(request, issue.id)).find((r) => r.status === 'running'),
			{ label: 'the run to start' }
		);
		const pid = Number.parseInt(
			await waitFor(async () => (existsSync(sideFile('sleep-pid')) ? readSideFile('sleep-pid') : undefined), {
				label: 'the harness pid'
			}),
			10
		);
		expect(pid).toBeGreaterThan(0);

		// The UI cancel dialog: strike note (this run hasn't moved the issue)
		// plus an optional comment posted BEFORE the cancellation.
		await signIn(context, ALICE.sessionToken);
		await page.goto('/agents');
		// Run rows show the issue ref (project/#number), not the title.
		const row = page
			.locator('li')
			.filter({ hasText: `${PROJECT_NAME}/#${issue.number}` })
			.filter({ hasText: 'running' })
			.first();
		await row.getByRole('button', { name: 'Cancel', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Cancel this run?' });
		await expect(dialog).toContainText('counts as a strike');
		await dialog.getByLabel(/Comment/).fill('Canceled from the dialog — try smaller steps');
		await dialog.getByRole('button', { name: 'Cancel run' }).click();
		await expect(dialog).toBeHidden();

		// The next poll's `cancels` list makes the daemon kill the process…
		await waitFor(
			async () => {
				try {
					process.kill(pid, 0);
					return false;
				} catch {
					return true;
				}
			},
			{ label: 'the harness process to die' }
		);
		// …and the run stays canceled: the daemon reported no finish over it.
		await new Promise((r) => setTimeout(r, 2500));
		const after = (await issueRuns(request, issue.id)).find((r) => r.id === running.id);
		expect(after?.status).toBe('canceled');
		// The dialog's comment was posted before the cancellation landed.
		const comments = await body<{ items: { body: string; created_at: number }[] }>(
			await api.get(`/api/v1/issues/${issue.id}/comments`)
		);
		const posted = comments.items.find((c) => c.body.startsWith('Canceled from the dialog'));
		expect(posted).toBeDefined();
		expect(posted!.created_at).toBeLessThanOrEqual(after!.ended_at!);
		// The workspace was cleaned up.
		await waitFor(
			async () => !existsSync(join(configDir, 'workspaces', running.id)),
			{ label: 'the workspace to be removed' }
		);
		setMode('work');
	});

	test('rotating the token 401s the daemon, which exits with guidance', async ({ request }) => {
		test.setTimeout(60_000);
		const api = apiClient(request, ALICE.apiKey);
		const res = await api.post(`/api/v1/runners/${runnerId}/rotate-token`);
		expect(res.ok()).toBe(true);
		const rotated = await body<{ runner: Runner; runner_token: string }>(res);
		expect(rotated.runner.id).toBe(runnerId);
		expect(rotated.runner_token).toMatch(/^tines_rt_/);

		await waitFor(async () => daemonExited, { label: 'the daemon to exit on 401' });
		expect(daemonOutput).toContain('rejected this runner');

		// The new token immediately works on the protocol; the runner identity
		// (id, history, rule references) is unchanged.
		const poll = await request.post(`/api/v1/runners/${runnerId}/poll`, {
			headers: { authorization: `Bearer ${rotated.runner_token}` },
			data: { owned_runs: [] }
		});
		expect(poll.ok()).toBe(true);
		expect(await body<{ assignments: unknown[]; cancels: string[] }>(poll)).toEqual({
			assignments: [],
			cancels: []
		});
	});

	test('runner tokens and run keys stay in their lanes', async ({ request }) => {
		// A user API key is not a runner token.
		const poll = await request.post(`/api/v1/runners/${runnerId}/poll`, {
			headers: { authorization: `Bearer ${ALICE.apiKey}` },
			data: { owned_runs: [] }
		});
		expect(poll.status()).toBe(401);
	});
});
