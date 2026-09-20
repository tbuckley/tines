/**
 * End-to-end over a resumed launch: a real `tines runner daemon` against a
 * stub supervisor whose assignment carries a `resume` block. What only the
 * daemon can be tested for lives here — that the kept workspace is launched
 * into rather than wiped and re-cloned, that the banner says which run is
 * being continued, that a workspace the server retained survives regardless
 * of `--keep-workspaces`, and that a vanished workspace degrades to a normal
 * cold launch. The flag and banner strings themselves are pinned in
 * support.test.ts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keptMarkerPath, workspacesDir } from './store.js';
import { CLI_BIN, NODE } from '../test-bin.js';

const RUN_ID = 'run_stub2';
const PREV_RUN_ID = 'run_stub1';

interface Harvest {
	log: string;
	finish: Record<string, unknown> | null;
}

/** The daemon's own console output — where the retention notice lands. */
let daemonOut = '';

/** Serves one assignment, resolving once the daemon finish-reports it. */
function stubSupervisor(opts: {
	resume?: Record<string, unknown>;
	repos?: unknown[];
	skills?: unknown[];
	finishReply?: Record<string, unknown>;
}): { server: Server; done: Promise<Harvest> } {
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
								prompt: 'THE CONTINUATION PROMPT',
								bundle: { skills: opts.skills ?? [], repos: opts.repos ?? [] },
								run_key: 'trk_stub_run_key',
								timeout_minutes: 30,
								...(opts.resume ? { resume: opts.resume } : {})
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
				harvest.finish = JSON.parse(body) as Record<string, unknown>;
				reply({ id: RUN_ID, ...(opts.finishReply ?? {}) });
				return resolve(harvest);
			}
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { code: 'not_found', message: url } }));
		});
	});
	return { server, done };
}

function startDaemon(port: number, dir: string, command: string): ChildProcess {
	const proc = spawn(
		NODE,
		[
			CLI_BIN,
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
	proc.stdout?.on('data', (chunk: Buffer) => (daemonOut += chunk.toString()));
	proc.stderr?.on('data', (chunk: Buffer) => (daemonOut += chunk.toString()));
	return proc;
}

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
	daemonOut = '';
	if (child) {
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

/** A previous run's kept workspace, with the traces a resume must not touch. */
function keptWorkspace(dir: string): string {
	const ws = join(workspacesDir(dir), PREV_RUN_ID);
	mkdirSync(join(ws, 'repo'), { recursive: true });
	mkdirSync(join(ws, '.agents/skills/stale'), { recursive: true });
	mkdirSync(join(ws, 'skills/legacy'), { recursive: true });
	writeFileSync(join(ws, 'repo', 'edit.txt'), 'work in progress');
	writeFileSync(join(ws, '.agents/skills/stale/SKILL.md'), 'stale');
	writeFileSync(join(ws, 'skills/legacy/SKILL.md'), 'legacy');
	writeFileSync(
		join(ws, 'repos.json'),
		`${JSON.stringify([{ name: 'repo', dir: 'repo', url: 'https://example.test/repo.git' }], null, 2)}\n`
	);
	writeFileSync(join(ws, 'prompt.md'), 'THE OLD PROMPT\n');
	writeFileSync(keptMarkerPath(ws), JSON.stringify({ run_id: PREV_RUN_ID, status: 'completed' }));
	return ws;
}

async function runOnce(opts: {
	resume?: (ws: string) => Record<string, unknown>;
	repos?: unknown[];
	skills?: unknown[];
	finishReply?: Record<string, unknown>;
	command?: string;
	prepare?: (dir: string) => string;
}): Promise<{ harvest: Harvest; prevWs: string; freshWs: string }> {
	daemonOut = '';
	configDir = mkdtempSync(join(tmpdir(), 'tines-daemon-'));
	const prevWs = (opts.prepare ?? keptWorkspace)(configDir);
	const stub = stubSupervisor({
		...(opts.resume ? { resume: opts.resume(prevWs) } : {}),
		...(opts.repos ? { repos: opts.repos } : {}),
		...(opts.skills ? { skills: opts.skills } : {}),
		...(opts.finishReply ? { finishReply: opts.finishReply } : {})
	});
	server = stub.server;
	await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
	const port = (server.address() as AddressInfo).port;
	child = startDaemon(port, configDir, opts.command ?? 'true');
	return {
		harvest: await stub.done,
		prevWs,
		freshWs: join(workspacesDir(configDir), RUN_ID)
	};
}

const resumeBlock = (ws: string) => ({
	previous_run_id: PREV_RUN_ID,
	provider_session_id: 'sess-abc',
	workspace_path: ws,
	prior_turn_count: 12
});

describe('resumed launch', () => {
	it('refreshes skills in the kept workspace without wiping repositories or legacy files', async () => {
		const { harvest, prevWs, freshWs } = await runOnce({
			resume: resumeBlock,
			// A repo that could never be cloned: reaching the clone loop at all
			// would fail the run, which is what makes the skip observable.
			repos: [{ name: 'repo', dir: 'repo', url: 'file:///nonexistent/repo.git', branch: null }],
			skills: [
				{
					name: 'current',
					files: [
						{ path: 'SKILL.md', content: 'current' },
						{ path: 'notes/info.txt', content: 'support' }
					]
				}
			],
			finishReply: { resume_expires_at: Date.now() + 48 * 60 * 60 * 1000 }
		});

		expect(harvest.finish).toMatchObject({ status: 'completed', workspace_path: prevWs });
		expect(existsSync(freshWs)).toBe(false);
		// The predecessor's clone and its edits are still there, untouched …
		expect(readFileSync(join(prevWs, 'repo', 'edit.txt'), 'utf8')).toBe('work in progress');
		expect(JSON.parse(readFileSync(join(prevWs, 'repos.json'), 'utf8'))).toHaveLength(1);
		// Generated skills and the prompt refresh; old-layout files are not owned.
		expect(readFileSync(join(prevWs, 'prompt.md'), 'utf8')).toBe('THE CONTINUATION PROMPT\n');
		expect(readFileSync(join(prevWs, '.agents/skills/current/SKILL.md'), 'utf8')).toBe('current');
		expect(readFileSync(join(prevWs, '.agents/skills/current/notes/info.txt'), 'utf8')).toBe(
			'support'
		);
		expect(existsSync(join(prevWs, '.agents/skills/stale'))).toBe(false);
		expect(readFileSync(join(prevWs, 'skills/legacy/SKILL.md'), 'utf8')).toBe('legacy');
		expect(harvest.log).not.toContain('git clone');
		// The run's own log says which run it continues.
		expect(harvest.log).toContain(`resumed=${PREV_RUN_ID}`);
		// The predecessor's kept marker is cleared on launch and rewritten by
		// this run's own retention: a live workspace never wears a stale one.
		expect(
			await waitFor(() => {
				if (!existsSync(keptMarkerPath(prevWs))) return false;
				const marker = JSON.parse(readFileSync(keptMarkerPath(prevWs), 'utf8')) as {
					run_id?: string;
				};
				return marker.run_id === RUN_ID;
			})
		).toBe(true);
	}, 30_000);

	it('a workspace the server retained is kept whatever --keep-workspaces says', async () => {
		// The daemon defaults to `never`; only the finish response's
		// `resume_expires_at` holds this one.
		const { harvest, prevWs } = await runOnce({
			resume: resumeBlock,
			finishReply: { resume_expires_at: Date.now() + 48 * 60 * 60 * 1000 }
		});
		expect(harvest.finish?.status).toBe('completed');
		expect(await waitFor(() => existsSync(keptMarkerPath(prevWs)))).toBe(true);
		expect(existsSync(join(prevWs, 'repo', 'edit.txt'))).toBe(true);
		expect(await waitFor(() => daemonOut.includes('workspace kept for resume at'))).toBe(true);
	}, 30_000);

	it('a retained workspace that is never resumed again is still pruned', async () => {
		// No `resume_expires_at` on the response: the server did not retain
		// this run, so `never` applies exactly as it did before the feature.
		const { harvest, prevWs } = await runOnce({ resume: resumeBlock });
		expect(harvest.finish?.status).toBe('completed');
		expect(await waitFor(() => !existsSync(prevWs))).toBe(true);
		expect(daemonOut).not.toContain('workspace kept for resume');
	}, 30_000);

	it('a resume whose workspace is gone launches fresh, cold prompt and all', async () => {
		const { harvest, prevWs, freshWs } = await runOnce({
			resume: (ws) => resumeBlock(join(ws, 'vanished')),
			finishReply: { resume_expires_at: Date.now() + 48 * 60 * 60 * 1000 }
		});
		expect(harvest.finish).toMatchObject({ status: 'completed', workspace_path: freshWs });
		expect(existsSync(join(freshWs, 'repos.json'))).toBe(true);
		expect(readFileSync(join(freshWs, 'prompt.md'), 'utf8')).toBe('THE CONTINUATION PROMPT\n');
		expect(harvest.log).not.toContain('resumed=');
		// The predecessor's own workspace is untouched by the fallback.
		expect(existsSync(prevWs)).toBe(true);
	}, 30_000);
});
