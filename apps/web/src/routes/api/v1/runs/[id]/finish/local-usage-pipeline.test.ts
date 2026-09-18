/**
 * The complete local boundary: a real bundled daemon consumes harness JSONL,
 * serializes its finish request over HTTP, and the production route stores the
 * independently priced result in D1. Keep this separate from the pure tests:
 * neither half can prove that their wire formats agree.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { sha256Hex } from '$lib/server/crypto';
import {
	addIssue,
	addRun,
	addRunner,
	eventsOfType,
	runById,
	seedBase,
	setSettings
} from '$lib/server/supervisor/test-fixtures';
import { CLI_BIN, NODE } from '../../../../../../../../../packages/cli/src/test-bin.js';
import type { FinishRunRequest } from '@tines/shared';
import { POST } from './+server';

// Build a private bundle from current source, even in a fresh isolated web run.
// A separate output also avoids racing the CLI suite's dist build.
let bundleDir: string;
let pipelineBin: string;
beforeAll(() => {
	bundleDir = mkdtempSync(join(tmpdir(), 'tines-pipeline-bundle-'));
	pipelineBin = join(bundleDir, 'index.mjs');
	execFileSync('pnpm', ['run', 'build', `--outfile=${pipelineBin}`], {
		cwd: dirname(dirname(CLI_BIN)),
		stdio: 'pipe',
		timeout: 30_000
	});
}, 35_000);
afterAll(() => {
	if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

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

function fakeClaude(root: string, cost: number | null, failed = false): string {
	const bin = join(root, 'bin');
	mkdirSync(bin, { recursive: true });
	const event =
		cost === null
			? { type: 'system', subtype: 'init', session_id: 'pipeline-claude' }
			: {
					type: 'result',
					subtype: failed ? 'error_during_execution' : 'success',
					is_error: failed,
					result: failed ? 'API Error: 529 Overloaded' : 'done',
					session_id: 'pipeline-claude',
					total_cost_usd: cost,
					num_turns: 3,
					usage: {
						input_tokens: 100,
						output_tokens: 20,
						cache_read_input_tokens: 30,
						cache_creation_input_tokens: 40
					}
				};
	// No final newline: the daemon must drain the renderer before finishing.
	writeFileSync(
		join(bin, 'claude'),
		`#!/bin/sh\nprintf '%s' '${JSON.stringify(event)}'\nexit ${failed ? 1 : 0}\n`,
		{ mode: 0o755 }
	);
	return bin;
}

async function runPipeline(
	harness: 'codex' | 'claude-code',
	model: string,
	fakeHarness: (root: string) => string
) {
	const t = createTestDb();
	seedBase(t);
	setSettings(t);
	const token = 'tines_rt_pipeline';
	const runner = addRunner(t, { harness });
	t.sqlite
		.prepare('UPDATE runner SET runner_token_hash = ? WHERE id = ?')
		.run(await sha256Hex(token), runner);
	const issue = addIssue(t);
	const run = addRun(t, { issueId: issue, runnerId: runner, status: 'running' });
	t.sqlite
		.prepare('UPDATE agent_run SET model = ?, created_at = ? WHERE id = ?')
		.run(model, Date.parse('2026-09-11T03:30:00Z'), run);
	let assigned = false;
	let finishStatus = 0;
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	let finishBody: FinishRunRequest | undefined;
	let finishCount = 0;
	let storedResponse: unknown;
	let logs = '';
	const done = new Promise<void>((r, fail) => {
		resolve = r;
		reject = fail;
	});
	const finish = async (raw: string, authorization = `Bearer ${token}`) => {
		const url = new URL(`http://test/api/v1/runs/${run}/finish`);
		const waits: Promise<unknown>[] = [];
		const response = await POST({
			platform: { env: t.env, ctx: { waitUntil: (p: Promise<unknown>) => waits.push(p) } },
			request: new Request(url, {
				method: 'POST',
				headers: { authorization, 'content-type': 'application/json' },
				body: raw
			}),
			url,
			params: { id: run }
		} as unknown as Parameters<typeof POST>[0]);
		await Promise.all(waits);
		return response;
	};
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', async () => {
			try {
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
										model,
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
				if (req.url === `/api/v1/runs/${run}/logs`) {
					logs += JSON.parse(raw).chunk;
					return reply({ ok: true });
				}
				if (req.url === `/api/v1/runs/${run}/finish`) {
					finishCount++;
					finishBody = JSON.parse(raw);
					const response = await finish(raw, req.headers.authorization ?? '');
					finishStatus = response.status;
					storedResponse = await response.json();
					res.writeHead(response.status, { 'content-type': 'application/json' });
					res.end(JSON.stringify(storedResponse));
					return resolve();
				}
				res.writeHead(404).end();
			} catch (error) {
				res.writeHead(500).end();
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
	await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
	dir = mkdtempSync(join(tmpdir(), 'tines-pipeline-'));
	const port = (server.address() as AddressInfo).port;
	child = spawn(
		NODE,
		[
			pipelineBin,
			'runner',
			'daemon',
			'--url',
			`http://127.0.0.1:${port}`,
			'--name',
			'pipeline',
			'--harness',
			harness,
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
				PATH: `${fakeHarness(dir)}${delimiter}${process.env.PATH ?? ''}`
			},
			stdio: ['ignore', 'pipe', 'pipe']
		}
	);
	let output = '';
	const capture = (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(-16_384);
	};
	child.stdout!.on('data', capture);
	child.stderr!.on('data', capture);
	child.once('error', reject);
	child.once('exit', (code, signal) => {
		reject(new Error(`Pipeline daemon exited before finish (${code ?? signal}):\n${output}`));
	});
	const deadline = setTimeout(
		() => reject(new Error(`Pipeline finish deadline:\n${output}`)),
		15_000
	);
	try {
		await done;
	} finally {
		clearTimeout(deadline);
	}
	expect(finishStatus).toBe(200);
	expect(finishCount).toBe(1);
	return { t, run, finishBody: finishBody!, storedResponse, logs, finish };
}

describe('local daemon usage pipeline', () => {
	it('prices a cumulative >272k all-short Codex run through the finish route and D1', async () => {
		const { t, run } = await runPipeline('codex', 'gpt-5.6-sol', fakeCodex);
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

	it.each([
		{ name: 'completed provider report', cost: 1.25, failed: false },
		{ name: 'measured zero provider report', cost: 0, failed: false },
		{ name: 'failed attempt with provider report', cost: 0.25, failed: true },
		{ name: 'incomplete failed attempt without result', cost: null, failed: true }
	])(
		'persists Claude $name through the daemon, authenticated route and D1',
		async ({ cost, failed }) => {
			const { t, run, finishBody, storedResponse, logs, finish } = await runPipeline(
				'claude-code',
				'claude-opus-5',
				(root) => fakeClaude(root, cost, failed)
			);
			const expected =
				cost === null
					? { cost_source: 'none' }
					: {
							cost_source: 'provider',
							cost_usd: cost,
							input_tokens: 100,
							output_tokens: 20,
							cache_read_tokens: 30,
							cache_write_tokens: 40
						};
			expect(finishBody.usage).toEqual(expected);
			expect(finishBody.status).toBe(failed ? 'failed' : 'completed');
			expect(finishBody.provider_session_id).toBe(cost === null ? undefined : 'pipeline-claude');
			const diagnostic = logs.split('\n').find((line) => line.startsWith('[usage] '));
			expect(JSON.parse(diagnostic!.slice('[usage] '.length))).toMatchObject({
				usage: expected,
				status: finishBody.status
			});
			const persisted = runById(t, run)!;
			expect(persisted.status).toBe(finishBody.status);
			expect(JSON.parse(persisted.usage as string)).toEqual(expected);
			expect(storedResponse).toMatchObject({
				usage: expected,
				provider_session_id: cost === null ? null : 'pipeline-claude'
			});
			const ended = eventsOfType(t, 'agent_run.ended');
			expect(ended).toHaveLength(1);
			expect(ended[0].payload.usage).toEqual(expected);
			// A late duplicate cannot replace provider authority, including zero/none.
			const duplicate = await finish(
				JSON.stringify({ ...finishBody, usage: { cost_source: 'provider', cost_usd: 999 } })
			);
			expect(duplicate.status).toBe(422);
			expect(await duplicate.json()).toMatchObject({ error: { code: 'run_already_ended' } });
			expect(runById(t, run)!.usage).toBe(persisted.usage);
			expect(eventsOfType(t, 'agent_run.ended')).toHaveLength(1);
		},
		30_000
	);
});
