import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerPollRequest } from '@tines/shared';
import { CLI_BIN, NODE } from '../test-bin.js';

function assignment(id: string): unknown {
	return {
		run: {
			id,
			issue_id: `iss_${id}`,
			issue_ref: { project_name: 'Stub', number: Number(id.at(-1)) },
			model: 'claude-sonnet-5',
			status: 'launching'
		},
		prompt: 'hold the slot',
		bundle: { skills: [], repos: [] },
		run_key: `tines_key_${id}`,
		timeout_minutes: 30
	};
}

let child: ChildProcess | null = null;
let server: Server | null = null;
let configDir: string | null = null;

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

describe('daemon concurrency admission', () => {
	it('launches every delivery below the local ceiling and declines only the overflow', async () => {
		const polls: RunnerPollRequest[] = [];
		let resolveDecline!: () => void;
		const declined = new Promise<void>((resolve) => (resolveDecline = resolve));
		server = createServer((req, res) => {
			let raw = '';
			req.on('data', (chunk) => (raw += chunk));
			req.on('end', () => {
				res.setHeader('content-type', 'application/json');
				if (req.url === '/api/v1/runners/register') {
					res.end(
						JSON.stringify({
							runner: { id: 'rnr_concurrency', name: 'concurrency-test' },
							runner_token: 'rt_stub'
						})
					);
					return;
				}
				if (req.url === '/api/v1/runners/rnr_concurrency/poll') {
					const poll = JSON.parse(raw) as RunnerPollRequest;
					polls.push(poll);
					if (poll.declined_assignments?.length) {
						res.statusCode = 409;
						res.end(
							JSON.stringify({
								error: { code: 'runner_conflict', message: 'test complete' }
							})
						);
						resolveDecline();
						return;
					}
					res.end(
						JSON.stringify({
							assignments:
								polls.length === 1
									? [assignment('run_1'), assignment('run_2'), assignment('run_3')]
									: [],
							cancels: []
						})
					);
					return;
				}
				if (req.url?.endsWith('/logs')) {
					res.end(JSON.stringify({ ok: true }));
					return;
				}
				res.statusCode = 404;
				res.end(JSON.stringify({ error: { code: 'not_found', message: req.url } }));
			});
		});
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as AddressInfo).port;
		configDir = mkdtempSync(join(tmpdir(), 'tines-concurrency-'));
		child = spawn(
			NODE,
			[
				CLI_BIN,
				'runner',
				'daemon',
				'--url',
				`http://127.0.0.1:${port}`,
				'--name',
				'concurrency-test',
				'--harness',
				'custom',
				'--command',
				'sleep 30',
				'--max-concurrent',
				'2',
				'--poll-interval',
				'1',
				'--no-cli-refresh'
			],
			{
				env: { ...process.env, TINES_API_KEY: 'usr_stub_key', TINES_CONFIG_DIR: configDir },
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()));

		await declined;
		await exited;
		expect(polls[1].owned_runs.sort()).toEqual(['run_1', 'run_2']);
		expect(polls[1].declined_assignments).toEqual(['run_3']);
	}, 15_000);
});
