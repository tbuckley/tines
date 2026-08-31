import { describe, expect, it } from 'vitest';
import {
	buildHarnessInvocation,
	expandCommandTemplate,
	LogBatcher,
	RunTable,
	shellQuote,
	type ManagedRun
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

describe('RunTable', () => {
	interface TestRun extends ManagedRun {
		flushed?: number;
	}

	function harness() {
		const finishes: { runId: string; status: string; error?: string }[] = [];
		const released: string[] = [];
		const logs: string[] = [];
		let persists = 0;
		let failFinish: string | null = null;
		const table = new RunTable<TestRun>({
			finish: async (run, status, error) => {
				if (failFinish) throw new Error(failFinish);
				finishes.push({ runId: run.runId, status, error });
			},
			release: (run) => released.push(run.runId),
			persist: () => (persists += 1),
			log: (m) => logs.push(m)
		});
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
		expect(h.released).toEqual(['arun_1']);
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
		expect(h.released).toEqual(['arun_1']);
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
		expect(h.released).toEqual(['arun_1']);
		expect(h.table.size).toBe(0);
		expect(h.logs.some((m) => m.includes('not accepted'))).toBe(true);
	});

	it('cleanup is idempotent and persists membership changes', () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		const after = h.persistCount();
		h.table.cleanup(run);
		h.table.cleanup(run);
		expect(h.persistCount()).toBe(after + 2);
		expect(h.released).toEqual(['arun_1', 'arun_1']); // release itself is idempotent (rm -rf force)
	});
});
