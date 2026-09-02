/**
 * End-to-end over `--keep-workspaces`: a real `tines runner daemon` against a
 * stub supervisor, running one-shot custom harnesses. The decision itself is
 * pinned in support.test.ts and the sweep in store.test.ts; what this covers
 * is the wiring only the daemon has — that a failing run's workspace actually
 * survives with its marker, that a completed one still does not, that the
 * "workspace kept at" line reaches the run's own log, and that the startup
 * sweep reaps kept directories without touching a live run's bare one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
	keptMarkerPath,
	workspacesDir,
	writeKeptMarker,
	type KeptWorkspaceMarker
} from './store.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', '..', 'node_modules', '.bin', 'tsx');
const entry = join(here, '..', 'index.ts');

const RUN_ID = 'run_stub1';

interface Harvest {
	log: string;
	finish: { status: string; error?: string } | null;
}

/**
 * Serves just enough of the runner protocol for one run, resolving once the
 * daemon finish-reports it. Note that the workspace decision happens *after*
 * that report (release runs last), so tests wait on the filesystem too.
 */
function stubSupervisor(): { server: Server; done: Promise<Harvest> } {
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
				const assignments = handedOut
					? []
					: [
							{
								run: {
									id: RUN_ID,
									issue_id: 'iss_1',
									issue_ref: { project_name: 'Stub', number: 1 },
									model: 'claude-sonnet-5',
									status: 'launching'
								},
								prompt: 'PROMPT BODY',
								bundle: { skills: [], repos: [] },
								run_key: 'trk_stub_run_key',
								timeout_minutes: 30
							}
						];
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

function startDaemon(port: number, dir: string, command: string, extra: string[]): ChildProcess {
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
			'--no-cli-refresh',
			...extra
		],
		{
			env: { ...process.env, TINES_API_KEY: 'usr_stub_key', TINES_CONFIG_DIR: dir },
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);
}

/** Polls a predicate — release happens after the finish report we wait on. */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return predicate();
}

let child: ChildProcess | null = null;
let configDir: string | null = null;
let server: Server | null = null;

afterEach(async () => {
	if (child) {
		// Wait for it to actually be gone: the daemon writes its state file and
		// sweeps the workspaces dir until the moment it dies, and a removal
		// racing that last write fails with ENOTEMPTY.
		const gone = new Promise<void>((resolve) => child!.once('close', () => resolve()));
		child.kill('SIGKILL');
		await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
		child = null;
	}
	server?.close();
	server = null;
	if (configDir)
		rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	configDir = null;
});

/** Boots stub + daemon and runs one assignment to its finish report. */
async function runOnce(
	command: string,
	extra: string[]
): Promise<{ harvest: Harvest; ws: string }> {
	const stub = stubSupervisor();
	server = stub.server;
	await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
	const port = (server.address() as AddressInfo).port;
	configDir = mkdtempSync(join(tmpdir(), 'tines-daemon-'));
	child = startDaemon(port, configDir, command, extra);
	return { harvest: await stub.done, ws: join(workspacesDir(configDir), RUN_ID) };
}

describe('--keep-workspaces', () => {
	it('failed: a harness that exits non-zero leaves its workspace, marked and logged', async () => {
		const { harvest, ws } = await runOnce('exit 3', ['--keep-workspaces', 'failed']);
		expect(harvest.finish).toEqual({ status: 'failed', error: 'harness exited with code 3' });
		expect(await waitFor(() => existsSync(keptMarkerPath(ws)))).toBe(true);
		// The clone the agent was editing is still there, not just the marker.
		expect(existsSync(join(ws, 'prompt.md'))).toBe(true);
		const marker = JSON.parse(readFileSync(keptMarkerPath(ws), 'utf8')) as KeptWorkspaceMarker;
		expect(marker).toMatchObject({
			run_id: RUN_ID,
			issue_ref: 'Stub/1',
			status: 'failed',
			error: 'harness exited with code 3'
		});
		expect(Number.isFinite(Date.parse(marker.kept_at))).toBe(true);
		// And the path is discoverable from the run's own log tail.
		expect(harvest.log.trimEnd().endsWith(`workspace kept at ${ws}`)).toBe(true);
	}, 30_000);

	it('failed: a completed run is still removed', async () => {
		const { harvest, ws } = await runOnce('true', ['--keep-workspaces', 'failed']);
		expect(harvest.finish).toEqual({ status: 'completed' });
		expect(await waitFor(() => !existsSync(ws))).toBe(true);
		expect(harvest.log).not.toContain('workspace kept at');
	}, 30_000);

	it('always: a completed run is kept too', async () => {
		const { harvest, ws } = await runOnce('true', ['--keep-workspaces', 'always']);
		expect(harvest.finish).toEqual({ status: 'completed' });
		expect(await waitFor(() => existsSync(keptMarkerPath(ws)))).toBe(true);
		const marker = JSON.parse(readFileSync(keptMarkerPath(ws), 'utf8')) as KeptWorkspaceMarker;
		expect(marker.status).toBe('completed');
		expect(marker.error).toBeUndefined();
	}, 30_000);

	it('never (the default): a failure is removed, exactly as before the flag', async () => {
		const { harvest, ws } = await runOnce('exit 3', []);
		expect(harvest.finish?.status).toBe('failed');
		expect(await waitFor(() => !existsSync(ws))).toBe(true);
		expect(harvest.log).not.toContain('workspace kept at');
	}, 30_000);

	it("sweeps expired kept workspaces at startup, leaving a live run's bare one alone", async () => {
		const stub = stubSupervisor();
		server = stub.server;
		await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
		const port = (server.address() as AddressInfo).port;
		configDir = mkdtempSync(join(tmpdir(), 'tines-daemon-'));

		// A kept workspace from a previous life, past any retention window …
		const stale = join(workspacesDir(configDir), 'run_stale');
		mkdirSync(stale, { recursive: true });
		writeKeptMarker(stale, {
			run_id: 'run_stale',
			status: 'failed',
			kept_at: '2020-01-01T00:00:00.000Z'
		});
		// … and another daemon's live run, which has no marker and must survive.
		const live = join(workspacesDir(configDir), 'run_someone_elses');
		mkdirSync(live, { recursive: true });

		child = startDaemon(port, configDir, 'true', ['--keep-workspaces-for', '1']);
		await stub.done;
		expect(await waitFor(() => !existsSync(stale))).toBe(true);
		expect(existsSync(live)).toBe(true);
	}, 30_000);
});
