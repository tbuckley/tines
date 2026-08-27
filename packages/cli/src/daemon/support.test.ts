import { describe, expect, it } from 'vitest';
import {
	buildHarnessInvocation,
	expandCommandTemplate,
	LogBatcher,
	shellQuote
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
	it('claude_code: claude -p <prompt> --model <model>', () => {
		expect(buildHarnessInvocation({ harness: 'claude_code' }, input)).toEqual({
			file: 'claude',
			args: ['-p', 'Do the thing', '--model', 'claude-sonnet-5']
		});
		expect(buildHarnessInvocation({ harness: 'claude_code' }, { ...input, model: null }).args).toEqual([
			'-p',
			'Do the thing'
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

	it('send failures go to onError and do not wedge later sends', async () => {
		const sent: string[] = [];
		const errors: unknown[] = [];
		let fail = true;
		const batcher = new LogBatcher(
			async (chunk) => {
				if (fail) throw new Error('offline');
				sent.push(chunk);
			},
			{ maxBytes: 1, onError: (e) => errors.push(e) }
		);
		batcher.append('a');
		await batcher.flush();
		fail = false;
		batcher.append('b');
		await batcher.flush();
		expect(errors).toHaveLength(1);
		expect(sent).toEqual(['b']);
	});

	it('an empty flush resolves without sending', async () => {
		const sent: string[] = [];
		const batcher = new LogBatcher(async (chunk) => void sent.push(chunk));
		await batcher.flush();
		expect(sent).toEqual([]);
	});
});
