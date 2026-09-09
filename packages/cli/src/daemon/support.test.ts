import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunJudgment } from './support';
import {
	AMBIENT_CLI,
	buildHarnessInvocation,
	buildSpawnEnv,
	CliRefresher,
	isNewerVersion,
	pathWithin,
	pendingSelfUpdate,
	exitLineForRun,
	expandCommandTemplate,
	formatExitLine,
	formatLaunchBanner,
	formatLaunchCommand,
	LogBatcher,
	keepWorkspace,
	RunTable,
	shellQuote,
	type AgentCli,
	type ManagedRun,
	type RunOutcome
} from './support.js';

const input = {
	workspace: '/tmp/ws/run 1',
	promptFile: '/tmp/ws/run 1/prompt.md',
	prompt: 'Do the thing',
	model: 'claude-sonnet-5'
};

describe('shellQuote', () => {
	it('single-quotes, escaping embedded quotes', () => {
		expect(shellQuote('plain')).toBe("'plain'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});
});

describe('expandCommandTemplate', () => {
	it('substitutes all three placeholders, quoted', () => {
		expect(expandCommandTemplate('agent {prompt_file} -w {workspace} -m {model}', input)).toBe(
			`agent '/tmp/ws/run 1/prompt.md' -w '/tmp/ws/run 1' -m 'claude-sonnet-5'`
		);
	});

	it('an absent model substitutes an empty shell word', () => {
		expect(expandCommandTemplate('agent {model}', { ...input, model: null })).toBe("agent ''");
	});

	it('repeated placeholders all expand', () => {
		expect(expandCommandTemplate('cat {prompt_file} {prompt_file}', input)).toBe(
			`cat '/tmp/ws/run 1/prompt.md' '/tmp/ws/run 1/prompt.md'`
		);
	});
});

describe('buildHarnessInvocation', () => {
	it('claude_code reads the prompt from prompt.md via stdin — never argv (ARG_MAX)', () => {
		expect(buildHarnessInvocation({ harness: 'claude_code' }, input)).toEqual({
			file: 'sh',
			args: [
				'-c',
				`claude -p --output-format stream-json --verbose --model 'claude-sonnet-5' < '/tmp/ws/run 1/prompt.md'`
			]
		});
		expect(
			buildHarnessInvocation({ harness: 'claude_code' }, { ...input, model: null }).args
		).toEqual([
			'-c',
			`claude -p --output-format stream-json --verbose < '/tmp/ws/run 1/prompt.md'`
		]);
	});

	it('codex: codex exec --json --skip-git-repo-check [--model] <prompt>', () => {
		expect(buildHarnessInvocation({ harness: 'codex' }, input)).toEqual({
			file: 'codex',
			args: [
				'exec',
				'--json',
				'--skip-git-repo-check',
				'--model',
				'claude-sonnet-5',
				'Do the thing'
			]
		});
	});

	it('custom: sh -c with the expanded template; refuses without one', () => {
		expect(
			buildHarnessInvocation({ harness: 'custom', command: 'run {prompt_file}' }, input)
		).toEqual({ file: 'sh', args: ['-c', `run '/tmp/ws/run 1/prompt.md'`] });
		expect(() => buildHarnessInvocation({ harness: 'custom' }, input)).toThrow(/--command/);
	});
});

describe('formatLaunchBanner', () => {
	const meta = { harness: 'claude_code' as const, timeoutMinutes: 30, cliVersion: '0.0.1' };

	it('claude_code: the sh -c script verbatim, then the metadata line', () => {
		const invocation = buildHarnessInvocation({ harness: 'claude_code' }, input);
		expect(formatLaunchBanner(invocation, input, meta)).toBe(
			`$ claude -p --output-format stream-json --verbose --model 'claude-sonnet-5' < '/tmp/ws/run 1/prompt.md'\n` +
				`# tines runner: harness=claude_code model=claude-sonnet-5 timeout=30m cli=0.0.1 workspace=/tmp/ws/run 1\n`
		);
	});

	it('a harness that cannot vary the model reads model=(fixed)', () => {
		const fixed = { ...input, model: null };
		const banner = formatLaunchBanner(
			buildHarnessInvocation({ harness: 'claude_code' }, fixed),
			fixed,
			meta
		);
		expect(banner).toContain('model=(fixed)');
		expect(banner).not.toContain('--model');
	});

	it('codex: argv shell-quoted, quoting only the words that need it', () => {
		const invocation = buildHarnessInvocation({ harness: 'codex' }, input);
		expect(formatLaunchBanner(invocation, input, { ...meta, harness: 'codex' })).toBe(
			`$ codex exec --json --skip-git-repo-check --model claude-sonnet-5 'Do the thing'\n` +
				`# tines runner: harness=codex model=claude-sonnet-5 timeout=30m cli=0.0.1 workspace=/tmp/ws/run 1\n`
		);
	});

	it('codex: a stitched prompt on argv is elided, not dumped into the log', () => {
		const prompt = 'x'.repeat(25_000);
		const big = { ...input, prompt };
		const line = formatLaunchCommand(buildHarnessInvocation({ harness: 'codex' }, big));
		expect(line.length).toBeLessThan(400);
		expect(line).toContain('[+24840 chars]');
		expect(
			line.startsWith('codex exec --json --skip-git-repo-check --model claude-sonnet-5 ')
		).toBe(true);
	});

	it('custom: the template as expanded, not as written', () => {
		const invocation = buildHarnessInvocation(
			{ harness: 'custom', command: 'my-agent --model {model} -w {workspace} < {prompt_file}' },
			input
		);
		expect(formatLaunchBanner(invocation, input, { ...meta, harness: 'custom' })).toBe(
			`$ my-agent --model 'claude-sonnet-5' -w '/tmp/ws/run 1' < '/tmp/ws/run 1/prompt.md'\n` +
				`# tines runner: harness=custom model=claude-sonnet-5 timeout=30m cli=0.0.1 workspace=/tmp/ws/run 1\n`
		);
	});

	it('never leaks the run key: it rides in the environment, never in argv', () => {
		const runKey = 'trk_supersecretrunkey';
		const env = buildSpawnEnv({}, { binDir: null, apiKey: runKey, apiUrl: 'https://tines.test' });
		expect(env.TINES_API_KEY).toBe(runKey);
		for (const spec of [
			{ harness: 'claude_code' as const },
			{ harness: 'codex' as const },
			{ harness: 'custom' as const, command: 'my-agent {prompt_file}' }
		]) {
			const banner = formatLaunchBanner(buildHarnessInvocation(spec, input), input, {
				...meta,
				harness: spec.harness
			});
			expect(banner).not.toContain(runKey);
			expect(banner).not.toContain('TINES_API_KEY');
		}
	});
});

describe('formatExitLine', () => {
	it('a clean exit reports its code and how long it took', () => {
		expect(formatExitLine({ code: 0, signal: null, durationMs: 192_000 })).toBe(
			'# tines runner: exit code=0 after 3m12s\n'
		);
		expect(formatExitLine({ code: 2, signal: null, durationMs: 900 })).toBe(
			'# tines runner: exit code=2 after 0m1s\n'
		);
	});

	it('a signalled exit reports the signal instead of a null code', () => {
		expect(formatExitLine({ code: null, signal: 'SIGKILL', durationMs: 61_000 })).toBe(
			'# tines runner: exit signal=SIGKILL after 1m1s\n'
		);
	});

	it('a timeout kill says so, so the log explains its own truncation', () => {
		expect(
			formatExitLine({ code: null, signal: 'SIGTERM', durationMs: 30 * 60_000, timedOut: true })
		).toBe('# tines runner: exit signal=SIGTERM (timed out) after 30m0s\n');
	});

	it('neither code nor signal (should not happen) still renders a line', () => {
		expect(formatExitLine({ code: null, signal: null, durationMs: 0 })).toBe(
			'# tines runner: exit code=? after 0m0s\n'
		);
	});
});

describe('exitLineForRun', () => {
	const exit = { code: null, signal: 'SIGTERM' as const, durationMs: 61_000 };

	it('a run we still own gets its line, timed out or not', () => {
		expect(exitLineForRun({ settled: false, timedOut: false }, exit)).toBe(
			'# tines runner: exit signal=SIGTERM after 1m1s\n'
		);
		expect(exitLineForRun({ settled: false, timedOut: true }, exit)).toBe(
			'# tines runner: exit signal=SIGTERM (timed out) after 1m1s\n'
		);
	});

	it('a settled run gets none — its batcher never flushes again', () => {
		expect(exitLineForRun({ settled: true, timedOut: false }, exit)).toBeNull();
	});
});

describe('LogBatcher', () => {
	it('flushes when the buffer reaches maxBytes, preserving order', async () => {
		const sent: string[] = [];
		const batcher = new LogBatcher(async (chunk) => void sent.push(chunk), { maxBytes: 10 });
		batcher.append('12345');
		expect(sent).toEqual([]); // under the threshold: waiting for the timer
		batcher.append('67890'); // hits 10 bytes: flushes immediately
		await batcher.flush();
		expect(sent).toEqual(['1234567890']);
	});

	it('manual flush drains the buffer and serializes sends', async () => {
		const sent: string[] = [];
		let resolveFirst!: () => void;
		const gate = new Promise<void>((r) => (resolveFirst = r));
		const batcher = new LogBatcher(
			async (chunk) => {
				if (sent.length === 0) await gate;
				sent.push(chunk);
			},
			{ maxBytes: 1 }
		);
		batcher.append('a'); // starts a send blocked on the gate
		batcher.append('b'); // queues behind it
		resolveFirst();
		await batcher.flush();
		expect(sent).toEqual(['a', 'b']);
	});

	it('retries a failed chunk on the next flush, keeping its seq and its place', async () => {
		const sent: { chunk: string; seq: number }[] = [];
		const errors: unknown[] = [];
		let fail = true;
		const batcher = new LogBatcher(
			async (chunk, seq) => {
				if (fail) throw new Error('offline');
				sent.push({ chunk, seq });
			},
			{ maxBytes: 1, onError: (e) => errors.push(e) }
		);
		batcher.append('a');
		await batcher.flush();
		// Every attempt while offline reports; how many depends on flush cadence.
		expect(errors.length).toBeGreaterThanOrEqual(1);
		// Dropping 'a' would put a hole in a log that is now durable, so it
		// waits — and goes out before 'b', under the seq it was first given.
		fail = false;
		batcher.append('b');
		await batcher.flush();
		expect(sent).toEqual([
			{ chunk: 'a', seq: 1 },
			{ chunk: 'b', seq: 2 }
		]);
	});

	it('drops the oldest backlog past the pending cap, with a marker', async () => {
		const sent: string[] = [];
		let fail = true;
		const batcher = new LogBatcher(
			async (chunk) => {
				if (fail) throw new Error('offline');
				sent.push(chunk);
			},
			{ maxBytes: 1, maxPendingBytes: 8 }
		);
		for (const text of ['aaaa', 'bbbb', 'cccc']) {
			batcher.append(text);
			await batcher.flush();
		}
		fail = false;
		await batcher.flush();
		expect(sent.join('')).toContain('bytes lost');
		expect(sent.join('')).toContain('cccc');
	});

	it('an empty flush resolves without sending', async () => {
		const sent: string[] = [];
		const batcher = new LogBatcher(async (chunk) => void sent.push(chunk));
		await batcher.flush();
		expect(sent).toEqual([]);
	});
});

describe('keepWorkspace', () => {
	it.each([
		['never', 'completed', false],
		['never', 'failed', false],
		['failed', 'completed', false],
		['failed', 'failed', true],
		['always', 'completed', true],
		['always', 'failed', true]
	] as const)('%s + %s → %s', (mode, outcome, expected) => {
		expect(keepWorkspace(mode, outcome)).toBe(expected);
	});
});

describe('RunTable', () => {
	interface TestRun extends ManagedRun {
		flushed?: number;
	}

	function harness(opts: { keep?: (outcome: RunOutcome) => boolean } = {}) {
		const finishes: {
			runId: string;
			status: string;
			error?: string;
			judgment?: RunJudgment;
		}[] = [];
		const released: { runId: string; keep: boolean; outcome: RunOutcome }[] = [];
		const notes: string[] = [];
		const logs: string[] = [];
		let persists = 0;
		let failFinish: string | null = null;
		const table = new RunTable<TestRun>(
			{
				finish: async (run, status, error, judgment) => {
					if (failFinish) throw new Error(failFinish);
					finishes.push({ runId: run.runId, status, error, judgment });
				},
				release: (run, { keep, outcome }) => released.push({ runId: run.runId, keep, outcome }),
				noteKept: (run) => notes.push(run.runId),
				persist: () => (persists += 1),
				log: (m) => logs.push(m)
			},
			opts
		);
		const run = (runId: string): TestRun => ({
			runId,
			workspace: `/ws/${runId}`,
			canceled: false,
			timedOut: false,
			settled: false
		});
		return {
			table,
			run,
			finishes,
			released,
			releasedIds: () => released.map((r) => r.runId),
			notes,
			logs,
			setFailFinish: (m: string) => (failFinish = m),
			persistCount: () => persists
		};
	}

	it('a normal finish flushes, reports once, and cleans up', async () => {
		const h = harness();
		const run = h.run('arun_1');
		let flushes = 0;
		run.flush = async () => void (flushes += 1);
		h.table.track(run);
		await h.table.finishAndCleanup(run, 'completed');
		expect(flushes).toBe(1);
		expect(h.finishes).toEqual([{ runId: 'arun_1', status: 'completed', error: undefined }]);
		expect(h.releasedIds()).toEqual(['arun_1']);
		expect(h.table.ids()).toEqual([]);
		// A second call (a racing exit handler) reports nothing more.
		await h.table.finishAndCleanup(run, 'failed', 'late');
		expect(h.finishes).toHaveLength(1);
	});

	it("a shutdown's finish is marked interrupted so the supervisor spares the issue", async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		await h.table.finishAndCleanup(run, 'failed', 'daemon shut down', {
			judgment: 'interrupted'
		});
		expect(h.finishes).toEqual([
			{
				runId: 'arun_1',
				status: 'failed',
				error: 'daemon shut down',
				judgment: { judgment: 'interrupted' }
			}
		]);
	});

	it('forwards a rate-limited judgment, resume time and all, unchanged', async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		await h.table.finishAndCleanup(run, 'failed', 'rate limited: session limit', {
			judgment: 'rate_limited',
			resume_at: 1_788_739_200_000
		});
		expect(h.finishes).toEqual([
			{
				runId: 'arun_1',
				status: 'failed',
				error: 'rate limited: session limit',
				judgment: { judgment: 'rate_limited', resume_at: 1_788_739_200_000 }
			}
		]);
	});

	it('an ordinary failure carries no judgment: the run failed, and that is a strike', async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		await h.table.finishAndCleanup(run, 'failed', 'harness exited with code 1');
		expect(h.finishes[0].judgment).toBeUndefined();
	});

	it('cancel during materialization: the later failure path still cleans up, without a report', async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		// The poll's cancels settled it while the workspace was materializing
		// (no pid yet) …
		expect(h.table.markCanceled('arun_1')).toBe(run);
		expect(run.settled).toBe(true);
		// … and the clone-failure (or spawn-error) branch then hits
		// finishAndCleanup: the slot, workspace, and state entry are released,
		// and nothing is finish-reported over the supervisor's settlement.
		await h.table.finishAndCleanup(run, 'failed', 'git clone failed');
		expect(h.finishes).toEqual([]);
		expect(h.releasedIds()).toEqual(['arun_1']);
		expect(h.table.size).toBe(0);
	});

	it('markCanceled ignores unknown and already-settled runs', async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		expect(h.table.markCanceled('arun_other')).toBeNull();
		h.table.markCanceled('arun_1');
		expect(h.table.markCanceled('arun_1')).toBeNull();
	});

	it('a rejected finish report still cleans up (the supervisor settled it first)', async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		h.setFailFinish('run_already_ended');
		await h.table.finishAndCleanup(run, 'failed', 'harness exited with code 1');
		expect(h.releasedIds()).toEqual(['arun_1']);
		expect(h.table.size).toBe(0);
		expect(h.logs.some((m) => m.includes('not accepted'))).toBe(true);
	});

	it('the keep decision reaches release, and only a kept run is noted in its log', async () => {
		const h = harness({ keep: (outcome) => outcome === 'failed' });
		// A completed run under keep-on-failed: removed, and nothing appended.
		const ok = h.run('arun_ok');
		h.table.track(ok);
		await h.table.finishAndCleanup(ok, 'completed');
		expect(h.released).toEqual([{ runId: 'arun_ok', keep: false, outcome: 'completed' }]);
		expect(h.notes).toEqual([]);

		// A failure: kept, with the error recorded as the marker's note.
		const bad = h.run('arun_bad');
		h.table.track(bad);
		await h.table.finishAndCleanup(bad, 'failed', 'harness exited with code 1');
		expect(h.released[1]).toEqual({ runId: 'arun_bad', keep: true, outcome: 'failed' });
		expect(h.notes).toEqual(['arun_bad']);
		expect(bad.endNote).toBe('harness exited with code 1');
	});

	it('notes a kept workspace before the flush — the only window an append still ships in', async () => {
		const h = harness({ keep: () => true });
		const run = h.run('arun_1');
		let letFlushFinish!: () => void;
		const gate = new Promise<void>((resolve) => (letFlushFinish = resolve));
		let flushed = false;
		run.flush = () => gate.then(() => void (flushed = true));
		h.table.track(run);
		const settling = h.table.finishAndCleanup(run, 'failed', 'timed out');
		// Synchronous up to the flush: the note is already in the batcher.
		expect(h.notes).toEqual(['arun_1']);
		expect(flushed).toBe(false);
		letFlushFinish();
		await settling;
		expect(flushed).toBe(true);
	});

	it('a supervisor cancel releases as a failure, with no note and no finish report', async () => {
		const h = harness({ keep: (outcome) => outcome === 'failed' });
		const run = h.run('arun_1');
		h.table.track(run);
		h.table.markCanceled(run.runId);
		// The exit handler's finishAndCleanup degrades to cleanup — which is
		// exactly the path that must still keep the workspace.
		await h.table.finishAndCleanup(run, 'failed', 'harness killed by SIGTERM');
		expect(h.finishes).toEqual([]);
		expect(h.notes).toEqual([]);
		expect(h.released).toEqual([{ runId: 'arun_1', keep: true, outcome: 'failed' }]);
	});

	it('a bare cleanup defaults to the failed outcome', () => {
		const h = harness({ keep: (outcome) => outcome === 'failed' });
		const run = h.run('arun_1');
		h.table.track(run);
		h.table.cleanup(run);
		expect(h.released).toEqual([{ runId: 'arun_1', keep: true, outcome: 'failed' }]);
	});

	it('without a keep decision, nothing is ever kept', async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		await h.table.finishAndCleanup(run, 'failed', 'boom');
		expect(h.released).toEqual([{ runId: 'arun_1', keep: false, outcome: 'failed' }]);
		expect(h.notes).toEqual([]);
	});

	it('cleanup is idempotent and persists membership changes', () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		const after = h.persistCount();
		h.table.cleanup(run);
		h.table.cleanup(run);
		expect(h.persistCount()).toBe(after + 2);
		expect(h.releasedIds()).toEqual(['arun_1', 'arun_1']); // release itself is idempotent (rm -rf force)
	});
});

describe('buildSpawnEnv', () => {
	const base = { PATH: '/usr/bin:/bin', HOME: '/home/agent' };

	it('prepends the managed CLI bin dir to PATH and sets the run credentials', () => {
		expect(
			buildSpawnEnv(base, {
				binDir: '/cfg/cli/node_modules/.bin',
				apiKey: 'k',
				apiUrl: 'https://t'
			})
		).toEqual({
			HOME: '/home/agent',
			PATH: `/cfg/cli/node_modules/.bin${delimiter}/usr/bin:/bin`,
			TINES_API_KEY: 'k',
			TINES_API_URL: 'https://t'
		});
	});

	it('leaves PATH untouched when there is no managed CLI', () => {
		expect(buildSpawnEnv(base, { binDir: null, apiKey: 'k', apiUrl: 'https://t' }).PATH).toBe(
			'/usr/bin:/bin'
		);
	});

	it('canonicalizes the API URL placed in the spawned harness environment', () => {
		expect(
			buildSpawnEnv(base, { binDir: null, apiKey: 'k', apiUrl: 'https://t.test///' }).TINES_API_URL
		).toBe('https://t.test');
	});

	it('tolerates an environment with no PATH at all', () => {
		expect(buildSpawnEnv({}, { binDir: '/cfg/bin', apiKey: 'k', apiUrl: 'https://t' }).PATH).toBe(
			'/cfg/bin'
		);
	});
});

describe('CliRefresher', () => {
	const fresh = (version: string): AgentCli => ({
		binDir: '/cfg/cli/node_modules/.bin',
		version,
		source: 'fresh'
	});

	/** A refresher over a counted, manually-resolved install and a fake clock. */
	function harness(install: (n: number) => Promise<AgentCli>, ttlMs = 1000) {
		let now = 0;
		let calls = 0;
		const refresher = new CliRefresher(() => install(++calls), { ttlMs, now: () => now });
		return {
			refresher,
			get calls() {
				return calls;
			},
			advance: (ms: number) => (now += ms)
		};
	}

	it('installs once, then serves the cache until the TTL elapses', async () => {
		const h = harness((n) => Promise.resolve(fresh(`0.0.${n}`)));
		expect(await h.refresher.ensure()).toEqual(fresh('0.0.1'));
		expect(await h.refresher.ensure()).toEqual(fresh('0.0.1'));
		expect(h.calls).toBe(1);

		h.advance(999);
		await h.refresher.ensure();
		expect(h.calls).toBe(1);

		h.advance(1);
		expect(await h.refresher.ensure()).toEqual(fresh('0.0.2'));
		expect(h.calls).toBe(2);
	});

	it('coalesces concurrent launches into one in-flight install', async () => {
		let release!: (cli: AgentCli) => void;
		const h = harness(() => new Promise<AgentCli>((resolve) => (release = resolve)));
		const first = h.refresher.ensure();
		const second = h.refresher.ensure();
		await Promise.resolve(); // the install effect starts on a microtask
		const third = h.refresher.ensure(); // …and this one joins it mid-flight
		expect(h.calls).toBe(1);
		release(fresh('0.0.9'));
		expect(await Promise.all([first, second, third])).toEqual([
			fresh('0.0.9'),
			fresh('0.0.9'),
			fresh('0.0.9')
		]);
		expect(h.calls).toBe(1);
	});

	it('TTL-gates failed attempts too — an offline machine is not retried per launch', async () => {
		const h = harness(() => Promise.resolve(AMBIENT_CLI));
		expect(await h.refresher.ensure()).toEqual(AMBIENT_CLI);
		await h.refresher.ensure();
		expect(h.calls).toBe(1);
	});

	it('degrades to the ambient PATH when install throws, rather than failing the launch', async () => {
		const h = harness(() => Promise.reject(new Error('boom')));
		await expect(h.refresher.ensure()).resolves.toEqual(AMBIENT_CLI);
		h.advance(1000);
		await expect(h.refresher.ensure()).resolves.toEqual(AMBIENT_CLI);
		expect(h.calls).toBe(2);
	});

	it('settled() waits out an in-flight install and never starts one', async () => {
		let release!: (cli: AgentCli) => void;
		const h = harness(() => new Promise<AgentCli>((resolve) => (release = resolve)));
		// Nothing in flight: resolves at once, and the TTL-expired refresher
		// did not take that as a cue to install.
		await h.refresher.settled();
		expect(h.calls).toBe(0);

		void h.refresher.ensure();
		await Promise.resolve();
		let done = false;
		const waiting = h.refresher.settled().then(() => (done = true));
		await Promise.resolve();
		expect(done).toBe(false);
		release(fresh('0.0.3'));
		await waiting;
		expect(done).toBe(true);
		expect(h.calls).toBe(1);
	});
});

describe('isNewerVersion', () => {
	it('compares dotted numeric parts, not strings', () => {
		expect(isNewerVersion('0.0.105', '0.0.99')).toBe(true);
		expect(isNewerVersion('0.0.99', '0.0.105')).toBe(false);
		expect(isNewerVersion('0.1.0', '0.0.999')).toBe(true);
		expect(isNewerVersion('1.0', '0.9.9')).toBe(true);
	});

	it('is strict: an equal version is not newer, nor is a shorter spelling of it', () => {
		expect(isNewerVersion('0.0.84', '0.0.84')).toBe(false);
		expect(isNewerVersion('1.0', '1.0.0')).toBe(false);
		expect(isNewerVersion('1.0.0', '1.0')).toBe(false);
	});

	it('never trusts a version it cannot parse, in either position', () => {
		expect(isNewerVersion('0.0.0-unknown', '0.0.1')).toBe(false);
		expect(isNewerVersion('9.9.9', '0.0.0-unknown')).toBe(false);
		expect(isNewerVersion('0.0.100-beta.1', '0.0.99')).toBe(false);
		expect(isNewerVersion('', '0.0.1')).toBe(false);
	});
});

describe('pendingSelfUpdate', () => {
	const cli = (version: string | null, source: AgentCli['source'] = 'fresh'): AgentCli => ({
		binDir: '/cfg/cli/node_modules/.bin',
		version,
		source
	});

	it('names a newer installed version, fresh or last-good', () => {
		expect(pendingSelfUpdate(cli('0.0.105'), '0.0.84')).toBe('0.0.105');
		expect(pendingSelfUpdate(cli('0.0.105', 'stale'), '0.0.84')).toBe('0.0.105');
	});

	it('is null for the ambient PATH, an unreadable version, or nothing newer', () => {
		expect(pendingSelfUpdate(AMBIENT_CLI, '0.0.84')).toBeNull();
		expect(pendingSelfUpdate(cli(null), '0.0.84')).toBeNull();
		expect(pendingSelfUpdate(cli('0.0.84'), '0.0.84')).toBeNull();
		expect(pendingSelfUpdate(cli('0.0.80'), '0.0.84')).toBeNull();
		// A repo checkout under tsx reports 0.0.1; every published release is
		// newer, but that daemon never runs from the prefix, so daemon.ts
		// never asks. The decision itself still says "newer".
		expect(pendingSelfUpdate(cli('0.0.105'), '0.0.1')).toBe('0.0.105');
	});
});

describe('pathWithin', () => {
	it('requires the boundary to fall on a separator', () => {
		expect(pathWithin('/cfg/cli/node_modules/tines/dist/index.js', '/cfg/cli')).toBe(true);
		expect(pathWithin('/cfg/cli/node_modules/tines/dist/index.js', '/cfg/cli/')).toBe(true);
		expect(pathWithin('/cfg/cli-old/node_modules/tines/dist/index.js', '/cfg/cli')).toBe(false);
		expect(pathWithin('/cfg/cli', '/cfg/cli')).toBe(false);
		expect(pathWithin('/opt/homebrew/lib/node_modules/tines/dist/index.js', '/cfg/cli')).toBe(
			false
		);
	});
});
