import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	AMBIENT_CLI,
	buildHarnessInvocation,
	buildSpawnEnv,
	CliRefresher,
	expandCommandTemplate,
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
		expect(buildHarnessInvocation({ harness: 'claude_code' }, { ...input, model: null }).args).toEqual([
			'-c',
			`claude -p --output-format stream-json --verbose < '/tmp/ws/run 1/prompt.md'`
		]);
	});

	it('codex: codex exec [--model] <prompt>', () => {
		expect(buildHarnessInvocation({ harness: 'codex' }, input)).toEqual({
			file: 'codex',
			args: ['exec', '--model', 'claude-sonnet-5', 'Do the thing']
		});
	});

	it('custom: sh -c with the expanded template; refuses without one', () => {
		expect(
			buildHarnessInvocation({ harness: 'custom', command: 'run {prompt_file}' }, input)
		).toEqual({ file: 'sh', args: ['-c', `run '/tmp/ws/run 1/prompt.md'`] });
		expect(() => buildHarnessInvocation({ harness: 'custom' }, input)).toThrow(/--command/);
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
		const finishes: { runId: string; status: string; error?: string }[] = [];
		const released: { runId: string; keep: boolean; outcome: RunOutcome }[] = [];
		const notes: string[] = [];
		const logs: string[] = [];
		let persists = 0;
		let failFinish: string | null = null;
		const table = new RunTable<TestRun>(
			{
				finish: async (run, status, error) => {
					if (failFinish) throw new Error(failFinish);
					finishes.push({ runId: run.runId, status, error });
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
			buildSpawnEnv(base, { binDir: '/cfg/cli/node_modules/.bin', apiKey: 'k', apiUrl: 'https://t' })
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

	it('tolerates an environment with no PATH at all', () => {
		expect(
			buildSpawnEnv({}, { binDir: '/cfg/bin', apiKey: 'k', apiUrl: 'https://t' }).PATH
		).toBe('/cfg/bin');
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
});
