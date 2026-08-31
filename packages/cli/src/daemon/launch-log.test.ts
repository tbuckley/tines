/**
 * End-to-end over the daemon's log wiring: a real `tines runner daemon`
 * against a stub supervisor, running a one-shot custom harness. The pure
 * formatters are pinned in support.test.ts; what this covers is the thing
 * they cannot — that the daemon actually appends the banner before the spawn
 * and the exit line after it, in the run's own log, in order.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cliVersion } from '../version.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', '..', 'node_modules', '.bin', 'tsx');
const entry = join(here, '..', 'index.ts');

const RUN_ID = 'run_stub1';
const RUN_KEY = 'trk_stub_run_key_never_logged';

/** The assignment the stub hands out once: no repos, no skills, one run. */
function assignment(timeoutMinutes: number): unknown {
	return {
		run: {
			id: RUN_ID,
			issue_id: 'iss_1',
			issue_ref: { project_name: 'Stub', number: 1 },
			model: 'claude-sonnet-5',
			status: 'launching'
		},
		prompt: 'PROMPT BODY',
		bundle: { skills: [], repos: [] },
		run_key: RUN_KEY,
		timeout_minutes: timeoutMinutes
	};
}

interface Harvest {
	log: string;
	finish: { status: string; error?: string } | null;
}

/**
 * Serves just enough of the runner protocol for one run, resolving once the
 * daemon finish-reports it (by which point every log chunk has been flushed —
 * finishAndCleanup flushes before it reports).
 */
function stubSupervisor(timeoutMinutes = 30): { server: Server; done: Promise<Harvest> } {
	const harvest: Harvest = { log: '', finish: null };
	let handedOut = false;
	let resolve!: (h: Harvest) => void;
	const done = new Promise<Harvest>((r) => (resolve = r));

	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			const url = req.url ?? '';
			const reply = (payload: unknown) => {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify(payload));
			};
			if (url === '/api/v1/runners/register') {
				return reply({ runner: { id: 'rnr_stub', name: 'stub' }, runner_token: 'rt_stub' });
			}
			if (url === '/api/v1/runners/rnr_stub/poll') {
				const assignments = handedOut ? [] : [assignment(timeoutMinutes)];
				handedOut = true;
				return reply({ assignments, cancels: [] });
			}
			if (url === `/api/v1/runs/${RUN_ID}/logs`) {
				harvest.log += (JSON.parse(body) as { chunk: string }).chunk;
				return reply({ ok: true });
			}
			if (url === `/api/v1/runs/${RUN_ID}/finish`) {
				harvest.finish = JSON.parse(body) as { status: string; error?: string };
				reply({ id: RUN_ID });
				return resolve(harvest);
			}
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { code: 'not_found', message: url } }));
		});
	});
	return { server, done };
}

/** Boots the daemon against the stub, with one command template to run. */
function startDaemon(port: number, dir: string, command: string): ChildProcess {
	return spawn(
		tsx,
		[
			entry,
			'runner',
			'daemon',
			'--url',
			`http://127.0.0.1:${port}`,
			'--name',
			'stub',
			'--harness',
			'custom',
			'--command',
			command,
			'--poll-interval',
			'1',
			'--no-cli-refresh'
		],
		{
			env: { ...process.env, TINES_API_KEY: 'usr_stub_key', TINES_CONFIG_DIR: dir },
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);
}

let child: ChildProcess | null = null;
let configDir: string | null = null;
let server: Server | null = null;

afterEach(async () => {
	// Wait for the daemon to actually be gone before removing its config dir:
	// kill() only sends the signal, and the daemon spends its last ticks
	// writing the run-state file and removing the workspace inside that same
	// directory — a delete racing it fails the test that just passed with
	// ENOTEMPTY. The retries cover the harness's own leftovers.
	if (child) {
		const proc = child;
		child = null;
		if (proc.exitCode === null && proc.signalCode === null) {
			const exited = new Promise<void>((r) => proc.once('exit', () => r()));
			proc.kill('SIGKILL');
			await exited;
		}
	}
	server?.close();
	server = null;
	if (configDir) rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	configDir = null;
});

describe('the run log a local run leaves behind', () => {
	it('opens with the launch banner and closes with the exit line', async () => {
		const { server: stub, done } = stubSupervisor();
		server = stub;
		await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
		const port = (stub.address() as AddressInfo).port;
		configDir = mkdtempSync(join(tmpdir(), 'tines-daemon-'));

		// A placeholder proves the log shows the template as expanded, not as
		// written — the whole point for a misbehaving --command.
		child = startDaemon(port, configDir, 'cat {prompt_file}');

		const harvest = await done;
		const workspace = join(configDir, 'workspaces', RUN_ID);
		const lines = harvest.log.trimEnd().split('\n');

		expect(harvest.finish).toEqual({ status: 'completed' });
		// Setup first (here: the --no-cli-refresh notice; a run with repos also
		// has its `$ git clone` lines), then the banner, then the harness.
		expect(lines[0]).toMatch(/^warning: no daemon-managed tines CLI/);
		expect(lines[1]).toBe(`$ cat '${join(workspace, 'prompt.md')}'`);
		expect(lines[2]).toBe(
			`# tines runner: harness=custom model=claude-sonnet-5 timeout=30m cli=${cliVersion()} workspace=${workspace}`
		);
		// The harness's own output sits between the banner and the exit line.
		expect(lines[3]).toBe('PROMPT BODY');
		expect(lines.at(-1)).toMatch(/^# tines runner: exit code=0 after \d+m\d+s$/);
		// The run key rides in the environment, never in the log.
		expect(harvest.log).not.toContain(RUN_KEY);
	}, 30_000);

	it('a harness the daemon times out says so on the way out', async () => {
		// 1.2s, so the daemon's own timeout fires while `sleep` is still asleep.
		const { server: stub, done } = stubSupervisor(0.02);
		server = stub;
		await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
		const port = (stub.address() as AddressInfo).port;
		configDir = mkdtempSync(join(tmpdir(), 'tines-daemon-'));

		child = startDaemon(port, configDir, 'sleep 30');

		const harvest = await done;
		const lines = harvest.log.trimEnd().split('\n');

		expect(harvest.finish?.status).toBe('failed');
		expect(harvest.finish?.error).toMatch(/timeout/);
		expect(lines[1]).toBe('$ sleep 30');
		expect(lines.at(-1)).toMatch(/^# tines runner: exit signal=SIGTERM \(timed out\) after \d+m\d+s$/);
	}, 30_000);
});
