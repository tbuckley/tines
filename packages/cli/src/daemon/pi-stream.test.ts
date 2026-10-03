import { describe, expect, it } from 'vitest';
import {
	PiRawSpoolFilter,
	PiStreamRenderer,
	renderPiEvent,
	spooledPiLine,
	type PiStreamEvent
} from './pi-stream';

/**
 * Fixtures are the streams `pi --mode json` 0.99.2 wrote against a mock model
 * endpoint while researching Tines/900 (a happy path with one bash call, the
 * same run against a server that reports no usage, and a 429, a 500 and a
 * refused connection), trimmed to the fields the renderer reads. The dropped
 * events (`message_start`, most `message_update`s, `tool_execution_update`,
 * the `agent_end` message list) render nothing; one of each is kept to prove it.
 */

/** A recorded line: more fields than the renderer's own event type admits. */
type Fixture = { type: string; message?: Record<string, unknown>; [field: string]: unknown };

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};
const REPORTED_USAGE = {
	input: 1034,
	output: 56,
	cacheRead: 200,
	cacheWrite: 0,
	reasoning: 0,
	totalTokens: 1290,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};
const COMMAND = 'echo tines-probe-1; which tines; echo key=${TINES_API_KEY:+set}';
const TOOL_OUTPUT = 'tines-probe-1\n/Users/t/.config/tines/cli/node_modules/.bin/tines\nkey=set\n';

const session = (id = '01a10335-d7b7-7690-aa36-7f04c20b8cb9') => ({
	type: 'session',
	version: 3,
	id,
	timestamp: '2026-10-03T19:20:22.711Z',
	cwd: '/private/tmp/pi-probe-900/ws'
});

const systemMessage = {
	role: 'system',
	content: '',
	sections: { preamble: 'You are an expert coding assistant operating inside pi.', cwd: '<cwd>' },
	toolsAdded: [{ name: 'bash', description: 'Execute bash commands' }]
};
const userMessage = {
	role: 'user',
	content: [{ type: 'text', text: 'Run the bash command and then reply DONE.' }]
};

function assistant(
	content: unknown[],
	fields: { usage?: unknown; model?: string; stopReason?: string; thinkingLevel?: string } = {}
) {
	return {
		role: 'assistant',
		content,
		api: 'openai-completions',
		provider: 'mock',
		model: fields.model ?? 'mock-think',
		usage: fields.usage ?? REPORTED_USAGE,
		stopReason: fields.stopReason ?? 'stop',
		thinkingLevel: fields.thinkingLevel ?? 'high'
	};
}

/** out1.jsonl / out-nousage.jsonl: text with a U+2028 in it, one bash call, then DONE. */
function happyPath(
	fields: { usage?: unknown; model?: string; thinkingLevel?: string } = {}
): Fixture[] {
	const toolCall = {
		type: 'toolCall',
		id: 'call_1',
		name: 'bash',
		arguments: { command: COMMAND }
	};
	const first = assistant([{ type: 'text', text: 'Running it. next' }, toolCall], {
		...fields,
		stopReason: 'toolUse'
	});
	const toolResult = {
		role: 'toolResult',
		toolCallId: 'call_1',
		toolName: 'bash',
		content: [{ type: 'text', text: TOOL_OUTPUT }],
		isError: false
	};
	const last = assistant([{ type: 'text', text: 'DONE' }], fields);
	return [
		session(),
		{ type: 'agent_start' },
		{ type: 'turn_start' },
		{ type: 'message_start', message: systemMessage },
		{ type: 'message_end', message: systemMessage },
		{ type: 'message_end', message: userMessage },
		{ type: 'message_start', message: { ...first, usage: ZERO_USAGE, stopReason: 'pending' } },
		{
			type: 'message_update',
			usage: fields.usage ?? REPORTED_USAGE,
			assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Running it. next' }
		},
		{ type: 'message_end', message: first },
		{
			type: 'tool_execution_start',
			toolCallId: 'call_1',
			toolName: 'bash',
			args: toolCall.arguments
		},
		{
			type: 'tool_execution_update',
			toolCallId: 'call_1',
			toolName: 'bash',
			args: toolCall.arguments,
			partialResult: { content: [{ type: 'text', text: 'tines-probe-1\n' }], details: {} }
		},
		{
			type: 'tool_execution_end',
			toolCallId: 'call_1',
			toolName: 'bash',
			result: {
				content: [{ type: 'text', text: TOOL_OUTPUT }],
				structuredContent: { output: TOOL_OUTPUT, truncated: false, exit_code: 0 }
			},
			isError: false
		},
		{ type: 'message_end', message: toolResult },
		{ type: 'turn_end', message: first, toolResults: [toolResult] },
		{ type: 'turn_start' },
		{ type: 'message_end', message: last },
		{ type: 'turn_end', message: last, toolResults: [] },
		{
			type: 'agent_end',
			messages: [systemMessage, userMessage, first, toolResult, last],
			willRetry: false
		},
		{ type: 'agent_settled' }
	];
}

/** out-err429.jsonl / out-err500.jsonl / out-down.jsonl: the call fails, one retry, it fails again. */
function failedCall(errorMessage: string): Fixture[] {
	const failed = {
		...assistant([], {
			usage: ZERO_USAGE,
			model: 'mock-plain',
			stopReason: 'error',
			thinkingLevel: 'off'
		}),
		errorMessage
	};
	const attempt = [
		{ type: 'agent_start' },
		{ type: 'turn_start' },
		{ type: 'message_end', message: failed },
		{ type: 'turn_end', message: failed, toolResults: [] }
	];
	return [
		session('01a10336-82cf-7142-ab13-c50f6124ef49'),
		{ type: 'message_end', message: systemMessage },
		{ type: 'message_end', message: userMessage },
		...attempt,
		{ type: 'agent_end', messages: [failed], willRetry: true },
		{ type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 200, errorMessage },
		{ type: 'entry_appended', entry: { type: 'context_edit', id: '8e0b3166', replacement: null } },
		...attempt,
		{ type: 'agent_end', messages: [failed], willRetry: false },
		{ type: 'auto_retry_end', success: false, attempt: 1, finalError: errorMessage },
		{ type: 'agent_settled' }
	];
}

const RATE_LIMITED =
	'429: {"message":"Rate limit reached: usage limit exceeded, try again later","type":"rate_limit_error","code":"rate_limit_exceeded"}';

function run(events: unknown[], opts: ConstructorParameters<typeof PiStreamRenderer>[1] = {}) {
	const out: string[] = [];
	const renderer = new PiStreamRenderer((line) => out.push(line), opts);
	renderer.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
	renderer.finish();
	return { log: out.join(''), lines: out, summary: renderer.summary() };
}

describe('renderPiEvent', () => {
	it('renders a tool call by what it does: the command, or the path', () => {
		expect(
			renderPiEvent({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls -la' } })
		).toEqual(['[tool] bash: ls -la']);
		expect(
			renderPiEvent({
				type: 'tool_execution_start',
				toolName: 'edit',
				args: { path: 'src/a.ts', edits: [{ oldText: 'x'.repeat(900), newText: 'y' }] }
			})
		).toEqual(['[tool] edit src/a.ts']);
		const [line] = renderPiEvent({
			type: 'tool_execution_start',
			toolName: 'search',
			args: { query: 'q'.repeat(500) }
		});
		expect(line!.startsWith('[tool] search {"query":"qqq')).toBe(true);
		expect(line!.length).toBe('[tool] search '.length + 301);
		expect(renderPiEvent({ type: 'tool_execution_start', toolName: 'status' })).toEqual([
			'[tool] status'
		]);
	});

	it('only a failed tool earns a result line', () => {
		expect(
			renderPiEvent({
				type: 'tool_execution_end',
				toolName: 'bash',
				result: { content: [{ type: 'text', text: 'ok\n' }], structuredContent: { exit_code: 0 } },
				isError: false
			})
		).toEqual([]);
		expect(
			renderPiEvent({
				type: 'tool_execution_end',
				toolName: 'bash',
				result: {
					content: [{ type: 'text', text: 'ls: nope: No such file or directory\n' }],
					structuredContent: { output: 'ls: nope: No such file or directory\n', exit_code: 1 }
				},
				isError: false
			})
		).toEqual(['[tool] bash failed: ls: nope: No such file or directory']);
		expect(
			renderPiEvent({
				type: 'tool_execution_end',
				toolName: 'read',
				result: { content: [{ type: 'text', text: 'e'.repeat(400) }] },
				isError: true
			})
		).toEqual([`[tool] read failed: ${'e'.repeat(300)}…`]);
	});

	it('names each retry and the error that ended them', () => {
		expect(
			renderPiEvent({
				type: 'auto_retry_start',
				attempt: 2,
				maxAttempts: 3,
				errorMessage: '500: x'
			})
		).toEqual(['[retry] attempt 2/3: 500: x']);
		expect(renderPiEvent({ type: 'auto_retry_end', success: false, finalError: '500: x' })).toEqual(
			['[error] 500: x']
		);
		expect(renderPiEvent({ type: 'auto_retry_end', success: true, attempt: 2 })).toEqual([]);
	});

	it('renders nothing for the per-token, bookkeeping, system and user events', () => {
		for (const event of [
			{ type: 'message_start', message: assistant([{ type: 'text', text: 'hi' }]) },
			{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } },
			{ type: 'tool_execution_update', toolName: 'bash' },
			{ type: 'agent_start' },
			{ type: 'agent_end', messages: [] },
			{ type: 'agent_settled' },
			{ type: 'turn_start' },
			{ type: 'turn_end', message: assistant([{ type: 'text', text: 'hi' }]) },
			{ type: 'entry_appended', entry: {} },
			{ type: 'message_end', message: systemMessage },
			{ type: 'message_end', message: userMessage }
		]) {
			expect(renderPiEvent(event as PiStreamEvent)).toEqual([]);
		}
	});
});

describe('PiStreamRenderer', () => {
	it('renders the happy path: session, model, agent text, the tool call', () => {
		const { log, summary } = run(happyPath());
		expect(log).toBe(
			'[session] started\n' +
				'[session] model mock/mock-think thinking=high\n' +
				'[agent] Running it. next\n' +
				`[tool] bash: ${COMMAND}\n` +
				'[agent] DONE\n'
		);
		expect(summary.providerSessionId).toBe('01a10335-d7b7-7690-aa36-7f04c20b8cb9');
		expect(summary.numTurns).toBe(2);
		expect(summary.harnessOutcome).toEqual({ kind: 'ok' });
		expect(summary.appliedEffort).toBe('high');
	});

	it('splits on LF only: a U+2028 inside a string is not a line boundary', () => {
		const out: string[] = [];
		const renderer = new PiStreamRenderer((line) => out.push(line));
		const raw = happyPath()
			.map((e) => JSON.stringify(e))
			.join('\n');
		// JSON.stringify leaves U+2028 raw, exactly as Pi writes it.
		expect(raw).toContain(' ');
		// Chunk boundaries fall anywhere, including mid-line and mid-event.
		for (let i = 0; i < raw.length; i += 97) renderer.write(raw.slice(i, i + 97));
		// No trailing newline: finish() renders the held last line.
		renderer.finish();
		expect(out).toContain('[agent] Running it. next\n');
		expect(out.filter((line) => line.startsWith('{'))).toEqual([]);
		expect(renderer.summary().numTurns).toBe(2);
	});

	it('sums usage across assistant messages, with no cost source when Pi priced nothing', () => {
		const { log, summary } = run(happyPath());
		expect(summary.usage).toEqual({
			input_tokens: 2068,
			output_tokens: 112,
			cache_read_tokens: 400,
			cache_write_tokens: 0
		});
		expect(log).not.toContain('[usage]');
	});

	it("passes on Pi's own cost when it is non-zero, and counts a tool result's usage", () => {
		const priced = { ...REPORTED_USAGE, cost: { total: 0.125 } };
		const events = happyPath({ usage: priced }).map((event) =>
			event.type === 'message_end' && event.message?.role === 'toolResult'
				? {
						...event,
						message: {
							...event.message,
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 3, cost: { total: 0.25 } }
						}
					}
				: event
		);
		expect(run(events).summary.usage).toEqual({
			input_tokens: 2078,
			output_tokens: 117,
			cache_read_tokens: 400,
			cache_write_tokens: 3,
			cost_usd: 0.5,
			cost_source: 'provider'
		});
	});

	it('zero usage: no token fields, and one labelled estimate line', () => {
		const { lines, summary } = run(happyPath({ usage: ZERO_USAGE, model: 'mock-plain' }));
		expect(summary.usage).toBeUndefined();
		expect(summary.harnessOutcome).toEqual({ kind: 'ok' });
		const usageLines = lines.filter((line) => line.startsWith('[usage]'));
		expect(usageLines).toHaveLength(1);
		expect(usageLines[0]).toMatch(
			/^\[usage\] the model server reported no token usage; rough estimate ~\d+ input \/ ~\d+ output tokens \(characters ÷ 4, not recorded\)\n$/
		);
		expect(lines.at(-1)).toBe(usageLines[0]);
		// The input side counts the conversation once per request, so the second
		// request's share includes the first answer and the tool result.
		const [, input, output] = usageLines[0]!.match(/~(\d+) input \/ ~(\d+) output/)!;
		const first =
			'Running it. next'.length + 'bash'.length + JSON.stringify({ command: COMMAND }).length;
		const prompt =
			Object.values(systemMessage.sections).join('').length +
			JSON.stringify(systemMessage.toolsAdded).length +
			userMessage.content[0]!.text.length;
		expect(Number(input)).toBe(Math.round((prompt + prompt + first + TOOL_OUTPUT.length) / 4));
		expect(Number(output)).toBe(Math.round((first + 'DONE'.length) / 4));
	});

	it('a resumed run says its estimate covers only this run', () => {
		const { log } = run(happyPath({ usage: ZERO_USAGE }), { resumed: true });
		expect(log).toMatch(/\(characters ÷ 4, not recorded\); this run's messages only\n$/);
	});

	it('finish() is idempotent: the estimate is written once', () => {
		const out: string[] = [];
		const renderer = new PiStreamRenderer((line) => out.push(line));
		renderer.write(
			happyPath({ usage: ZERO_USAGE })
				.map((e) => JSON.stringify(e))
				.join('\n') + '\n'
		);
		renderer.finish();
		renderer.finish();
		expect(out.filter((line) => line.startsWith('[usage]'))).toHaveLength(1);
	});

	it('a 429 is rate_limited, though pi exits 0', () => {
		const { log, summary } = run(failedCall(RATE_LIMITED));
		expect(log).toBe(
			'[session] started\n' +
				'[session] model mock/mock-plain thinking=off\n' +
				`[retry] attempt 1/1: ${RATE_LIMITED}\n` +
				`[error] ${RATE_LIMITED}\n`
		);
		expect(summary.harnessOutcome).toEqual({ kind: 'rate_limited', detail: RATE_LIMITED });
		expect(summary.usage).toBeUndefined();
		// A call that never answered proves no applied effort, and gets no estimate.
		expect(summary.appliedEffort).toBeUndefined();
		expect(summary.numTurns).toBe(2);
	});

	it('a 500 and a refused connection are provider errors', () => {
		const internal = '500: {"message":"internal server error"}';
		expect(run(failedCall(internal)).summary.harnessOutcome).toEqual({
			kind: 'provider_error',
			detail: internal
		});
		for (const detail of [
			'Connection error.',
			'TypeError: fetch failed',
			'connect ECONNREFUSED ::1:1'
		]) {
			expect(run(failedCall(detail)).summary.harnessOutcome).toEqual({
				kind: 'provider_error',
				detail
			});
		}
	});

	it('any other failed call is a plain error, with the best detail there is', () => {
		const bad = '400: {"message":"model not found"}';
		expect(run(failedCall(bad)).summary.harnessOutcome).toEqual({ kind: 'error', detail: bad });
		// No errorMessage on the message: the retry's final error, else the stop reason.
		const bare = assistant([], { usage: ZERO_USAGE, stopReason: 'aborted' });
		expect(
			run([
				session(),
				{ type: 'message_end', message: bare },
				{ type: 'auto_retry_end', success: false, finalError: '503: overloaded' }
			]).summary.harnessOutcome
		).toEqual({ kind: 'provider_error', detail: '503: overloaded' });
		expect(run([session(), { type: 'message_end', message: bare }]).summary.harnessOutcome).toEqual(
			{ kind: 'error', detail: 'aborted' }
		);
	});

	it('a failed call that a retry recovers from ends ok', () => {
		const failed = {
			...assistant([], { usage: ZERO_USAGE, stopReason: 'error' }),
			errorMessage: RATE_LIMITED
		};
		const { summary } = run([
			session(),
			{ type: 'message_end', message: failed },
			{ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: RATE_LIMITED },
			{ type: 'message_end', message: assistant([{ type: 'text', text: 'DONE' }]) },
			{ type: 'auto_retry_end', success: true, attempt: 1 }
		]);
		expect(summary.harnessOutcome).toEqual({ kind: 'ok' });
	});

	it('no assistant message at all is an error', () => {
		const expected = { kind: 'error', detail: 'pi ended without an assistant message' };
		expect(run([]).summary.harnessOutcome).toEqual(expected);
		expect(
			run([session(), { type: 'agent_start' }, { type: 'message_end', message: userMessage }])
				.summary.harnessOutcome
		).toEqual(expected);
	});

	it('reports the thinking level Pi applied, once — a silent clamp shows as a different level', () => {
		const applied: string[] = [];
		// Assigned `high`, on a model with no thinking: Pi clamps to `off`.
		const { summary } = run(happyPath({ thinkingLevel: 'off', model: 'mock-plain' }), {
			onAppliedEffort: (level) => applied.push(level)
		});
		expect(applied).toEqual(['off']);
		expect(summary.appliedEffort).toBe('off');
	});

	it('takes the applied level from the first answer, not from a failed call before it', () => {
		const applied: string[] = [];
		const failed = {
			...assistant([], { usage: ZERO_USAGE, stopReason: 'error', thinkingLevel: 'off' }),
			errorMessage: RATE_LIMITED
		};
		run(
			[
				session(),
				{ type: 'message_end', message: failed },
				{ type: 'message_end', message: assistant([{ type: 'text', text: 'DONE' }]) }
			],
			{ onAppliedEffort: (level) => applied.push(level) }
		);
		expect(applied).toEqual(['high']);
	});

	it('passes through whatever is not a JSON object, verbatim', () => {
		const out: string[] = [];
		const renderer = new PiStreamRenderer((line) => out.push(line));
		renderer.write('Warning: something\n{not json\n[1,2]\n\n');
		renderer.write(`${JSON.stringify(session())}\n`);
		renderer.finish();
		expect(out).toEqual(['Warning: something\n', '{not json\n', '[1,2]\n', '[session] started\n']);
	});

	it('ignores a session id that could not be a resume handle', () => {
		expect(run([session('bad\u0000id')]).summary.providerSessionId).toBeUndefined();
	});
});

describe('raw spool filter', () => {
	const line = (event: unknown) => JSON.stringify(event);

	it('drops the per-token and per-chunk lines and empties agent_end', () => {
		expect(spooledPiLine(line({ type: 'message_update', usage: ZERO_USAGE }))).toBeNull();
		expect(spooledPiLine(line({ type: 'message_start', message: userMessage }))).toBeNull();
		expect(spooledPiLine(line({ type: 'tool_execution_update', toolName: 'bash' }))).toBeNull();
		expect(spooledPiLine(line({ type: 'agent_end', messages: [userMessage] }))).toBe(
			'{"type":"agent_end"}'
		);
		// A line that does not lead with `type` is still recognized.
		expect(spooledPiLine(line({ usage: ZERO_USAGE, type: 'message_update' }))).toBeNull();
	});

	it('keeps everything else exactly as it came', () => {
		for (const kept of [
			line(session()),
			line({ type: 'message_end', message: userMessage }),
			line({ type: 'tool_execution_end', toolName: 'bash', isError: false }),
			line({ type: 'turn_end' }),
			line({ note: 'no type' }),
			'Warning: not json',
			'{not json',
			''
		]) {
			expect(spooledPiLine(kept)).toBe(kept);
		}
	});

	it('filters whole lines across chunk boundaries and flushes a trailing one', () => {
		const filter = new PiRawSpoolFilter();
		const update = line({ type: 'message_update', delta: 'a line\u2028separator' });
		const end = line({ type: 'message_end', message: userMessage });
		const stream = `${line(session())}\n${update}\n${end}\n${update}\n${line({ type: 'agent_end', messages: [userMessage] })}`;
		let out = '';
		// Three-character chunks: every line is split somewhere inside it.
		for (let i = 0; i < stream.length; i += 3) out += filter.write(stream.slice(i, i + 3));
		expect(out).toBe(`${line(session())}\n${end}\n`);
		expect(filter.end()).toBe('{"type":"agent_end"}');
		expect(filter.end()).toBe('');
	});

	it('drops a trailing partial line that would have been dropped whole', () => {
		const filter = new PiRawSpoolFilter();
		expect(filter.write(line({ type: 'message_update' }))).toBe('');
		expect(filter.end()).toBe('');
	});
});
