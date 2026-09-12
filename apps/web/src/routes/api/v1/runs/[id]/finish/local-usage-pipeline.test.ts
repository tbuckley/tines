/**
 * The complete local boundary: a real bundled daemon consumes Codex JSONL,
 * serializes its finish request over HTTP, and the production route stores the
 * independently priced result in D1. Keep this separate from the pure tests:
 * neither half can prove that their wire formats agree.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { sha256Hex } from '$lib/server/crypto';
import {
	addIssue,
	addRun,
	addRunner,
	runById,
	seedBase,
	setSettings
} from '$lib/server/supervisor/test-fixtures';
import { CLI_BIN, NODE } from '../../../../../../../../../packages/cli/src/test-bin.js';
import { POST } from './+server';

let child: ChildProcess | null = null;
let server: Server | null = null;
let dir: string | null = null;

afterEach(async () => {
	if (child?.exitCode === null && child.signalCode === null) {
		const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
		child.kill('SIGKILL');
		await exited;
	}
	child = null;
	server?.close();
	server = null;
	if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
	dir = null;
});

function fakeCodex(root: string): string {
	const bin = join(root, 'bin');
	mkdirSync(bin, { recursive: true });
	const thread = '01a09350-f9cc-7160-8a73-60d458864a7e';
	const usage = {
		input_tokens: 300_000,
		cached_input_tokens: 210_000,
		cache_write_input_tokens: 10_000,
		output_tokens: 3_000
	};
	const meta = JSON.stringify({
		type: 'session_meta',
		payload: { id: thread, source: 'exec', originator: 'codex_exec', cli_version: '0.153.4' }
	});
	const count = (total: typeof usage, last: typeof usage) =>
		JSON.stringify({
			type: 'event_msg',
			payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } }
		});
	const first = {
		...usage,
		input_tokens: 150_000,
		cached_input_tokens: 100_000,
		cache_write_input_tokens: 0,
		output_tokens: 1_000
	};
	const last = {
		...usage,
		input_tokens: 150_000,
		cached_input_tokens: 110_000,
		output_tokens: 2_000
	};
	writeFileSync(
		join(bin, 'codex'),
		`#!/bin/sh\nday="$(date -u +%Y/%m/%d)"\nmkdir -p "$CODEX_HOME/sessions/$day"\nprintf '%s\\n' '${meta}' '${count(first, first)}' '${count(usage, last)}' > "$CODEX_HOME/sessions/$day/rollout-${thread}.jsonl"\nprintf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: thread })}' '${JSON.stringify({ type: 'turn.completed', usage })}'\n`,
		{ mode: 0o755 }
	);
	return bin;
}

describe('local daemon usage pipeline', () => {
	it('prices a cumulative >272k all-short Codex run through the finish route and D1', async () => {
		const t = createTestDb();
		seedBase(t);
		setSettings(t);
		const token = 'tines_rt_pipeline';
		const runner = addRunner(t);
		t.sqlite
			.prepare('UPDATE runner SET runner_token_hash = ? WHERE id = ?')
			.run(await sha256Hex(token), runner);
		const issue = addIssue(t);
		const run = addRun(t, { issueId: issue, runnerId: runner, status: 'running' });
		t.sqlite
			.prepare('UPDATE agent_run SET model = ?, created_at = ? WHERE id = ?')
			.run('gpt-5.6-sol', Date.parse('2026-09-11T03:30:00Z'), run);
		let assigned = false;
		let finishStatus = 0;
		let resolve!: () => void;
		const done = new Promise<void>((r) => (resolve = r));
		server = createServer((req, res) => {
			let raw = '';
			req.on('data', (chunk) => (raw += chunk));
			req.on('end', async () => {
				const reply = (body: unknown) => {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify(body));
				};
				if (req.url === '/api/v1/runners/register')
					return reply({ runner: { id: runner, name: 'pipeline' }, runner_token: token });
				if (req.url === `/api/v1/runners/${runner}/poll`) {
					const assignments = assigned
						? []
						: [
								{
									run: {
										id: run,
										issue_id: issue,
										issue_ref: { project_name: 'Tines', number: 1 },
										model: 'gpt-5.6-sol',
										status: 'launching'
									},
									prompt: 'finish',
									bundle: { skills: [], repos: [] },
									run_key: 'trk_pipeline',
									timeout_minutes: 1
								}
							];
					assigned = true;
					return reply({ assignments, cancels: [] });
				}
				if (req.url === `/api/v1/runs/${run}/logs`) return reply({ ok: true });
				if (req.url === `/api/v1/runs/${run}/finish`) {
					const url = new URL(`http://test${req.url}`);
					const waits: Promise<unknown>[] = [];
					const response = await POST({
						platform: { env: t.env, ctx: { waitUntil: (p: Promise<unknown>) => waits.push(p) } },
						request: new Request(url, {
							method: 'POST',
							headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
							body: raw
						}),
						url,
						params: { id: run }
					} as unknown as Parameters<typeof POST>[0]);
					finishStatus = response.status;
					await Promise.all(waits);
					res.writeHead(response.status, { 'content-type': 'application/json' });
					res.end(await response.text());
					return resolve();
				}
				res.writeHead(404).end();
			});
		});
		await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
		dir = mkdtempSync(join(tmpdir(), 'tines-pipeline-'));
		const port = (server.address() as AddressInfo).port;
		child = spawn(
			NODE,
			[
				CLI_BIN,
				'runner',
				'daemon',
				'--url',
				`http://127.0.0.1:${port}`,
				'--name',
				'pipeline',
				'--harness',
				'codex',
				'--poll-interval',
				'1',
				'--no-cli-refresh'
			],
			{
				env: {
					...process.env,
					TINES_API_KEY: 'usr_pipeline',
					TINES_CONFIG_DIR: dir,
					CODEX_HOME: join(dir, 'codex-home'),
					PATH: `${fakeCodex(dir)}${delimiter}${process.env.PATH ?? ''}`
				},
				stdio: 'ignore'
			}
		);
		await done;
		expect(finishStatus).toBe(200);
		const usage = JSON.parse(runById(t, run)!.usage as string);
		expect(usage).toMatchObject({
			cost_source: 'priced',
			cost_usd: 0.514,
			pricing: {
				status: 'calculated',
				evidence: {
					request_context: {
						status: 'complete',
						request_count: 2,
						max_request_input_tokens: 150_000
					}
				}
			}
		});
	}, 30_000);
});
