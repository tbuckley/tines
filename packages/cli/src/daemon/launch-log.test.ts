/**
 * End-to-end over the daemon's log wiring: a real `tines runner daemon`
 * against a stub supervisor, running a one-shot custom harness. The pure
 * formatters are pinned in support.test.ts; what this covers is the thing
 * they cannot — that the daemon actually appends the banner before the spawn
 * and the exit line after it, in the run's own log, in order.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FinishRunRequest } from '@tines/shared';
import { cliVersion } from '../version.js';
import { CLI_BIN, NODE } from '../test-bin.js';

const RUN_ID = 'run_stub1';
const RUN_KEY = 'trk_stub_run_key_never_logged';

/** The assignment the stub hands out once: no repos, no skills, one run. */
function assignment(timeoutMinutes: number, model: string): unknown {
	return {
		run: {
			id: RUN_ID,
			issue_id: 'iss_1',
			issue_ref: { project_name: 'Stub', number: 1 },
			model,
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
	finish: FinishRunRequest | null;
}

/**
 * Serves just enough of the runner protocol for one run, resolving once the
 * daemon finish-reports it (by which point every log chunk has been flushed —
 * finishAndCleanup flushes before it reports).
 */
function stubSupervisor(
	timeoutMinutes = 30,
	model = 'claude-sonnet-5'
): {
	server: Server;
	done: Promise<Harvest>;
	/** Live view, for tests that must act while the run is still going. */
	harvest: Harvest;
} {
	const harvest: Harvest = { log: '', finish: null };
	let handedOut = false;
	let resolve!: (h: Harvest) => void;
	const done = new Promise<Harvest>((r, reject) => {
		resolve = r;
		rejectPending = reject;
	});

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
				const assignments = handedOut ? [] : [assignment(timeoutMinutes, model)];
				handedOut = true;
				return reply({ assignments, cancels: [] });
			}
			if (url === `/api/v1/runs/${RUN_ID}/logs`) {
				harvest.log += (JSON.parse(body) as { chunk: string }).chunk;
				return reply({ ok: true });
			}
			if (url === `/api/v1/runs/${RUN_ID}/finish`) {
				harvest.finish = JSON.parse(body) as Harvest['finish'];
				reply({ id: RUN_ID });
				return resolve(harvest);
			}
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { code: 'not_found', message: url } }));
		});
	});
	return { server, done, harvest };
}

/**
 * A `claude` for the claude_code harness to find on PATH: one complete
 * stream-json line, then half of a second one, then a hang — the shape of a
 * harness killed mid-event, which is what leaves a fragment for `drain`.
 */
function fakeClaude(dir: string): string {
	const bin = join(dir, 'fakebin');
	mkdirSync(bin, { recursive: true });
	const event = (text: string) =>
		JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
	writeFileSync(
		join(bin, 'claude'),
		`#!/bin/sh\nprintf '%s\\n' '${event('a whole event')}'\nprintf '%s' '${event('cut off mid-line')}'\nsleep 30\n`,
		{ mode: 0o755 }
	);
	return bin;
}

/** A claude_code process whose structured result reports a provider outage. */
function fakeClaudeProviderError(dir: string, exitCode = 1): string {
	const bin = join(dir, 'fakebin');
	mkdirSync(bin, { recursive: true });
	const event = JSON.stringify({
		type: 'result',
		subtype: 'error_during_execution',
		is_error: true,
		result: 'API Error: 529 Overloaded',
		session_id: 'session_failed',
		total_cost_usd: 0.25,
		usage: { input_tokens: 10, output_tokens: 2 }
	});
	writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' '${event}'\nexit ${exitCode}\n`, {
		mode: 0o755
	});
	return bin;
}

/**
 * A claude_code launcher that exits immediately while its inherited writer
 * emits a terminal result larger than a typical pipe buffer. The missing
 * trailing newline also makes the renderer hold the event until stdout has
 * fully closed.
 */
function fakeClaudeBufferedResult(dir: string): string {
	const bin = join(dir, 'fakebin');
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, 'claude-writer.mjs'),
		`const event = {
	type: 'result',
	subtype: 'success',
	is_error: false,
	result: 'done',
	session_id: 'session_buffered',
	total_cost_usd: 1.25,
	num_turns: 3,
	duration_ms: 456,
	usage: {
		input_tokens: 100,
		output_tokens: 20,
		cache_read_input_tokens: 30,
		cache_creation_input_tokens: 40
	},
	padding: 'x'.repeat(4 * 1024 * 1024)
};
await new Promise((resolve) => setTimeout(resolve, 50));
process.stdout.write(JSON.stringify(event));
	`
	);
	// A short-lived launcher leaves its writer holding stdout open. Node's
	// child-process `exit` event fires for the launcher immediately; `close`
	// waits until the inherited pipe is drained, which is the production
	// invariant this fixture exists to pin.
	writeFileSync(
		join(bin, 'claude'),
		`#!/bin/sh
node "$(dirname "$0")/claude-writer.mjs" &
exit 0
`,
		{ mode: 0o755 }
	);
	return bin;
}

function fakeCodex(dir: string, exitCode = 0): string {
	const bin = join(dir, 'fakebin');
	mkdirSync(bin, { recursive: true });
	const threadId = '01a09350-f9cc-7160-8a73-60d458864a7e';
	const started = JSON.stringify({ type: 'thread.started', thread_id: threadId });
	const message = JSON.stringify({
		type: 'item.completed',
		item: { type: 'agent_message', text: 'Codex finished.' }
	});
	const completed = JSON.stringify({
		type: 'turn.completed',
		usage: {
			input_tokens: 300_000,
			cached_input_tokens: 210_000,
			cache_write_input_tokens: 10_000,
			output_tokens: 3_000
		}
	});
	const meta = JSON.stringify({
		type: 'session_meta',
		payload: { id: threadId, source: 'exec', originator: 'codex_exec', cli_version: '0.153.4' }
	});
	const count = (total: unknown, last: unknown) =>
		JSON.stringify({
			type: 'event_msg',
			payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } }
		});
	const first = {
		input_tokens: 150_000,
		cached_input_tokens: 100_000,
		cache_write_input_tokens: 0,
		output_tokens: 1_000
	};
	const total = {
		input_tokens: 300_000,
		cached_input_tokens: 210_000,
		cache_write_input_tokens: 10_000,
		output_tokens: 3_000
	};
	const last = {
		input_tokens: 150_000,
		cached_input_tokens: 110_000,
		cache_write_input_tokens: 10_000,
		output_tokens: 2_000
	};
	writeFileSync(
		join(bin, 'codex'),
		`#!/bin/sh
day="$(date -u +%Y/%m/%d)"
mkdir -p "$CODEX_HOME/sessions/$day"
printf '%s\\n' '${meta}' '${count(first, first)}' '${count(first, first)}' '${count(total, last)}' > "$CODEX_HOME/sessions/$day/rollout-test-${threadId}.jsonl"
printf '%s\\n' '${started}' '${message}' '${completed}'
exit ${exitCode}
`,
		{ mode: 0o755 }
	);
	return bin;
}

/** Boots the daemon against the stub: a custom template, or claude_code. */
function startDaemon(
	port: number,
	dir: string,
	harness: { command: string } | { fakeClaudeDir: string } | { fakeCodexDir: string },
	trailingSlashes = 0
): ChildProcess {
	const args = [
		CLI_BIN,
		'runner',
		'daemon',
		'--url',
		`http://127.0.0.1:${port}${'/'.repeat(trailingSlashes)}`,
		'--name',
		'stub',
		'--poll-interval',
		'1',
		'--no-cli-refresh'
	];
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TINES_API_KEY: 'usr_stub_key',
		TINES_CONFIG_DIR: dir
	};
	if ('command' in harness) args.push('--harness', 'custom', '--command', harness.command);
	else if ('fakeClaudeDir' in harness) {
		args.push('--harness', 'claude_code');
		env.PATH = `${harness.fakeClaudeDir}${delimiter}${process.env.PATH ?? ''}`;
	} else {
		args.push('--harness', 'codex');
		env.PATH = `${harness.fakeCodexDir}${delimiter}${process.env.PATH ?? ''}`;
		env.CODEX_HOME = join(dir, 'codex-home');
	}
	const daemon = spawn(NODE, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = '';
	daemon.stderr?.on(
		'data',
		(data: Buffer) => (stderr = (stderr + data.toString('utf8')).slice(-4000))
	);
	daemon.on('exit', (code) => {
		if (code === null) return;
		rejectPending?.(
			new Error(`daemon exited with code ${code} before the run was reported:\n${stderr}`)
		);
	});
	return daemon;
}

let child: ChildProcess | null = null;
let configDir: string | null = null;
let server: Server | null = null;
/**
 * Fails the pending `done` the moment the daemon dies on its own. Without
 * this a daemon crash (an unhandled error at boot, say) reads as a silent
 * 30-second timeout with no clue why — the daemon's stderr is not otherwise
 * surfaced. afterEach's SIGKILL exits with a signal, not a code, so it does
 * not trip this.
 */
let rejectPending: ((err: Error) => void) | null = null;

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
	if (configDir)
		rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
		// A caller with multiple trailing slashes still reaches every protocol
		// endpoint; the stub deliberately recognizes only canonical paths.
		child = startDaemon(port, configDir, { command: 'cat {prompt_file}' }, 3);

		const harvest = await done;
		const workspace = join(configDir, 'workspaces', RUN_ID);
		const lines = harvest.log.trimEnd().split('\n');

		expect(harvest.finish).toEqual({
			workspace_path: expect.any(String),
			status: 'completed',
			usage: { cost_source: 'none' }
		});
		// Setup first (here: the --no-cli-refresh notice; a run with repos also
		// has its `$ git clone` lines), then the banner, then the harness.
		expect(lines[0]).toMatch(/^warning: no daemon-managed tines CLI/);
		expect(lines[1]).toBe(`$ cat '${join(workspace, 'prompt.md')}'`);
		expect(lines[2]).toBe(
			`# tines runner: harness=custom model=claude-sonnet-5 effort=(provider-default) timeout=30m cli=${cliVersion()} workspace=${workspace}`
		);
		// The harness's own output sits between the banner and the exit line.
		expect(lines[3]).toBe('PROMPT BODY');
		expect(lines.at(-2)).toMatch(/^# tines runner: exit code=0 after \d+m\d+s$/);
		expect(lines.at(-1)).toMatch(/^\[usage\] /);
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

		child = startDaemon(port, configDir, { command: 'sleep 30' });

		const harvest = await done;
		const lines = harvest.log.trimEnd().split('\n');

		expect(harvest.finish?.status).toBe('failed');
		expect(harvest.finish?.error).toMatch(/timeout/);
		expect(lines[1]).toBe('$ sleep 30');
		expect(lines.at(-2)).toMatch(
			/^# tines runner: exit signal=SIGTERM \(timed out\) after \d+m\d+s$/
		);
	}, 30_000);

	it('a daemon shutting down reports its in-flight runs as interrupted', async () => {
		const { server: stub, done, harvest } = stubSupervisor();
		server = stub;
		await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
		const port = (stub.address() as AddressInfo).port;
		configDir = mkdtempSync(join(tmpdir(), 'tines-daemon-'));

		child = startDaemon(port, configDir, { command: 'sleep 30' });
		// Ctrl-C only once the harness is genuinely under way — a shutdown
		// before delivery would report nothing at all.
		await expect.poll(() => harvest.log.length, { timeout: 20_000 }).toBeGreaterThan(0);
		child.kill('SIGTERM');

		// The Ctrl-C killed the run; the agent did not fail. The supervisor
		// needs to be told that, or every CLI upgrade costs an issue a strike.
		expect((await done).finish).toEqual({
			workspace_path: expect.any(String),
			status: 'failed',
			error: 'daemon shut down',
			judgment: 'interrupted',
			usage: { cost_source: 'none' }
		});
	}, 30_000);

	it('a claude_code harness killed mid-event says its last words first', async () => {
		const { server: stub, done } = stubSupervisor(0.02);
		server = stub;
		await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
		const port = (stub.address() as AddressInfo).port;
		configDir = mkdtempSync(join(tmpdir(), 'tines-daemon-'));

		child = startDaemon(port, configDir, { fakeClaudeDir: fakeClaude(configDir) });

		const harvest = await done;
		const lines = harvest.log.trimEnd().split('\n');

		expect(harvest.finish?.status).toBe('failed');
		expect(lines[1]).toMatch(
			/^\$ claude -p --output-format stream-json --verbose --model 'claude-sonnet-5' < '.*\/prompt\.md'$/
		);
		expect(lines).toContain('[agent] a whole event');
		// The renderer holds a partial line until its newline; SIGTERM means it
		// never comes, so the daemon drains it — before the closing line, or
		// the log would not end with the line that says how the run ended.
		expect(lines.at(-3)).toBe('[agent] cut off mid-line');
		expect(lines.at(-2)).toMatch(
			/^# tines runner: exit signal=SIGTERM \(timed out\) after \d+m\d+s$/
		);
		expect(lines.at(-1)).toMatch(/^\[usage\] /);
	}, 30_000);

	it('a provider outage is reported as interrupted instead of striking the issue', async () => {
		const { server: stub, done } = stubSupervisor();
		server = stub;
		await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
		const port = (stub.address() as AddressInfo).port;
		configDir = mkdtempSync(join(tmpdir(), 'tines-daemon-'));

		child = startDaemon(port, configDir, {
			fakeClaudeDir: fakeClaudeProviderError(configDir)
		});

		const harvest = await done;
		expect(harvest.finish).toEqual({
			workspace_path: expect.any(String),
			status: 'failed',
			error: 'provider error: API Error: 529 Overloaded',
			judgment: 'interrupted',
			usage: {
				cost_source: 'provider',
				cost_usd: 0.25,
				input_tokens: 10,
				output_tokens: 2
			},
			provider_session_id: 'session_failed'
		});
		expect(harvest.log).toContain('[error] API Error: 529 Overloaded');
	}, 30_000);

	it('does not override a successful harness exit based on its output alone', async () => {
		const { server: stub, done } = stubSupervisor();
		server = stub;
		await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
		const port = (stub.address() as AddressInfo).port;
		configDir = mkdtempSync(join(tmpdir(), 'tines-daemon-'));

		child = startDaemon(port, configDir, {
			fakeClaudeDir: fakeClaudeProviderError(configDir, 0)
		});

		expect((await done).finish).toEqual({
			workspace_path: expect.any(String),
			status: 'completed',
			usage: {
				cost_source: 'provider',
				cost_usd: 0.25,
				input_tokens: 10,
				output_tokens: 2
			},
			provider_session_id: 'session_failed'
		});
	}, 30_000);

	it('drains a large unterminated result before reporting an immediately exiting harness', async () => {
		const { server: stub, done } = stubSupervisor();
		server = stub;
		await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
		const port = (stub.address() as AddressInfo).port;
		configDir = mkdtempSync(join(tmpdir(), 'tines-daemon-'));

		child = startDaemon(port, configDir, {
			fakeClaudeDir: fakeClaudeBufferedResult(configDir)
		});

		const harvest = await done;
		expect(harvest.finish).toEqual({
			workspace_path: expect.any(String),
			status: 'completed',
			usage: {
				cost_source: 'provider',
				cost_usd: 1.25,
				input_tokens: 100,
				output_tokens: 20,
				cache_read_tokens: 30,
				cache_write_tokens: 40
			},
			provider_session_id: 'session_buffered',
			// The turn counts the resume size guard reads. A cold run's
			// conversation is exactly this run, so the two agree.
			turn_count: 3,
			conversation_turn_count: 3
		});
		expect(harvest.log).toContain('[session] result: success (3 turns, $1.25)');
	}, 30_000);

	it('reports local Codex tokens and thread id while keeping logs readable', async () => {
		const { server: stub, done } = stubSupervisor(30, 'gpt-5.6-sol');
		server = stub;
		await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
		const port = (stub.address() as AddressInfo).port;
		configDir = mkdtempSync(join(tmpdir(), 'tines-daemon-'));

		child = startDaemon(port, configDir, { fakeCodexDir: fakeCodex(configDir) });
		const harvest = await done;
		expect(harvest.finish).toMatchObject({
			workspace_path: expect.any(String),
			status: 'completed',
			usage: {
				input_tokens: 80_000,
				cache_read_tokens: 210_000,
				cache_write_tokens: 10_000,
				output_tokens: 3_000
			},
			provider_session_id: '01a09350-f9cc-7160-8a73-60d458864a7e',
			pricing_evidence: {
				model: 'gpt-5.6-sol',
				measurement_status: 'complete',
				terminal_snapshots: 1,
				daemon_version: cliVersion(),
				request_context: {
					status: 'complete',
					request_count: 2,
					max_request_input_tokens: 150_000,
					reconciled_usage: {
						input_tokens: 300_000,
						cached_input_tokens: 210_000,
						cache_write_input_tokens: 10_000,
						output_tokens: 3_000
					}
				}
			}
		});
		const accounting = harvest.log
			.trimEnd()
			.split('\n')
			.find((line) => line.startsWith('[usage] '));
		expect(JSON.parse(accounting!.slice('[usage] '.length))).toMatchObject({
			pricing_evidence: {
				raw_usage: harvest.finish!.pricing_evidence!.raw_usage,
				request_context: harvest.finish!.pricing_evidence!.request_context
			}
		});
		expect(harvest.log).toContain('[agent] Codex finished.');
		expect(harvest.log).not.toContain('"thread.started"');
	}, 30_000);

	it('does not use rollout proof for a failed Codex attempt', async () => {
		const { server: stub, done } = stubSupervisor(30, 'gpt-5.6-sol');
		server = stub;
		await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
		const port = (stub.address() as AddressInfo).port;
		configDir = mkdtempSync(join(tmpdir(), 'tines-daemon-'));

		child = startDaemon(port, configDir, { fakeCodexDir: fakeCodex(configDir, 1) });
		const harvest = await done;
		expect(harvest.finish).toMatchObject({
			status: 'failed',
			usage: {
				input_tokens: 80_000,
				cache_read_tokens: 210_000,
				cache_write_tokens: 10_000,
				output_tokens: 3_000
			},
			pricing_evidence: {
				measurement_status: 'complete',
				request_context: { status: 'unavailable', reason: 'not_applicable' }
			}
		});
	}, 30_000);
});
