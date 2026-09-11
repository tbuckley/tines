import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerPollRequest } from '@tines/shared';
import { CLI_BIN, NODE } from '../test-bin.js';

let child: ChildProcess | null = null;
let configDir: string | null = null;
let server: Server | null = null;

afterEach(async () => {
	if (child?.exitCode === null && child.signalCode === null) {
		const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
		child.kill('SIGKILL');
		await exited;
	}
	child = null;
	server?.close();
	server = null;
	if (configDir) rmSync(configDir, { recursive: true, force: true });
	configDir = null;
});

function startDaemon(port: number, dir: string): ChildProcess {
	return spawn(
		NODE,
		[
			CLI_BIN,
			'runner',
			'daemon',
			'--url',
			`http://127.0.0.1:${port}`,
			'--name',
			'fenced-test',
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

describe('daemon instance fencing', () => {
	it('keeps one boot id, retries unrelated conflicts, and exits cleanly when superseded', async () => {
		const polls: RunnerPollRequest[] = [];
		let resolveConflict!: () => void;
		const conflictSent = new Promise<void>((resolve) => (resolveConflict = resolve));
		server = createServer((req, res) => {
			let raw = '';
			req.on('data', (chunk) => (raw += chunk));
			req.on('end', () => {
				res.setHeader('content-type', 'application/json');
				if (req.url === '/api/v1/runners/register') {
					res.end(
						JSON.stringify({
							runner: { id: 'rnr_stub', name: 'fenced-test' },
							runner_token: 'rt_stub'
						})
					);
					return;
				}
				if (req.url === '/api/v1/runners/rnr_stub/poll') {
					polls.push(JSON.parse(raw) as RunnerPollRequest);
					if (polls.length === 2) {
						res.statusCode = 409;
						res.end(JSON.stringify({ error: { code: 'busy', message: 'try again' } }));
						return;
					}
					if (polls.length === 3) {
						res.statusCode = 409;
						res.end(
							JSON.stringify({
								error: {
									code: 'runner_conflict',
									message: 'another daemon instance is serving this runner'
								}
							})
						);
						resolveConflict();
						return;
					}
					res.end(JSON.stringify({ assignments: [], cancels: [] }));
					return;
				}
				res.statusCode = 404;
				res.end(JSON.stringify({ error: { code: 'not_found', message: req.url } }));
			});
		});
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as AddressInfo).port;
		configDir = mkdtempSync(join(tmpdir(), 'tines-fencing-'));
		child = startDaemon(port, configDir);
		let stderr = '';
		child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
			child?.once('exit', (code, signal) => resolve({ code, signal }))
		);

		await conflictSent;
		expect(await exited).toEqual({ code: 0, signal: null });
		expect(polls).toHaveLength(3);
		expect(polls.map((poll) => poll.instance_id)).toEqual([
			polls[0].instance_id,
			polls[0].instance_id,
			polls[0].instance_id
		]);
		expect(polls[0].instance_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(stderr).toContain('runner fenced-test was superseded');
		expect(stderr).toContain('this daemon is exiting');
	}, 15_000);
});
