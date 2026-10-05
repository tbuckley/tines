import { describe, expect, it } from 'vitest';
import {
	classifyCodexFailure,
	CodexStreamRenderer,
	parseCodexResetTime,
	renderCodexEvent
} from './codex-stream.js';

// Real lines. September's is from a production run log (ASCII apostrophe);
// the rest are Codex 0.156.1's own stream (U+2019).
const VISIT = 'Visit https://chatgpt.com/codex/settings/usage to purchase more credits';
const LIMIT_SEPTEMBER = `You've hit your usage limit. ${VISIT} or try again at Sep 19th, 2026 5:01 AM.`;
const LIMIT_DATED = `You’ve hit your usage limit. ${VISIT} or try again at Oct 7th, 2026 2:58 PM.`;
const LIMIT_SAME_DAY = `You’ve hit your usage limit. ${VISIT} or try again at 3:06 PM.`;
const LIMIT_NO_RESET = 'You’ve hit your usage limit. Try again later.';
const CAPACITY = 'Selected model is at capacity. Please try a different model.';
const HIGH_DEMAND = 'We’re currently experiencing high demand, which may cause temporary errors.';

/** Codex reports a refusal twice: a top-level `error`, then the failed turn. */
function refusal(message: string): unknown[] {
	return [
		{ type: 'thread.started', thread_id: 'thread_123' },
		{ type: 'turn.started' },
		{ type: 'error', message },
		{ type: 'turn.failed', error: { message } }
	];
}

// 14:56 local on 2026-10-04, whatever zone the test runs in.
const NOW = new Date(2026, 9, 4, 14, 56).getTime();
const MINUTE = 60_000;

function collect(events: unknown[], now?: () => number) {
	const lines: string[] = [];
	const renderer = new CodexStreamRenderer((line) => lines.push(line), now);
	renderer.write(events.map((event) => JSON.stringify(event)).join('\n'));
	renderer.finish();
	return { log: lines.join(''), summary: renderer.summary() };
}

describe('CodexStreamRenderer', () => {
	it('renders activity and captures thread plus cache-normalized terminal usage', () => {
		const result = collect([
			{ type: 'thread.started', thread_id: 'thread_123' },
			{ type: 'turn.started' },
			{ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
			{
				type: 'turn.completed',
				usage: {
					input_tokens: 1000,
					cached_input_tokens: 600,
					cache_write_input_tokens: 100,
					output_tokens: 100
				}
			}
		]);
		expect(result.log).toContain('[agent] Done.');
		expect(result.summary).toMatchObject({
			providerSessionId: 'thread_123',
			usage: {
				input_tokens: 300,
				cache_read_tokens: 600,
				cache_write_tokens: 100,
				output_tokens: 100
			},
			pricingEvidence: { measurement_status: 'complete', terminal_snapshots: 1 }
		});
	});

	it('rejects overlapping cache classes and keeps independently valid counters', () => {
		expect(
			collect([
				{
					type: 'turn.completed',
					usage: { input_tokens: 5, cached_input_tokens: 9, output_tokens: -1 }
				}
			]).summary.usage
		).toEqual({ cache_read_tokens: 9 });
		expect(
			collect([{ type: 'turn.completed', usage: { cached_input_tokens: 3 } }]).summary.usage
		).toEqual({ cache_read_tokens: 3 });
	});

	it('retains the latest valid snapshot and returns defensive copies', () => {
		const lines: string[] = [];
		const renderer = new CodexStreamRenderer((line) => lines.push(line));
		renderer.write('{"type":"thread.started","thread_id":"t1"}\n');
		renderer.write('{"type":"turn.completed","usage":{"output_tokens":2}}\n');
		const first = renderer.summary();
		first.usage!.output_tokens = 99;
		expect(renderer.summary().usage).toEqual({ output_tokens: 2 });
		renderer.write(
			'{"type":"turn.completed","usage":{"input_tokens":4,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":3}}\n'
		);
		expect(renderer.summary().usage).toEqual({
			input_tokens: 4,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			output_tokens: 3
		});
	});

	it('keeps prose, ignores unknown JSON, and tolerates incomplete errors', () => {
		const result = collect([{ type: 'unknown' }, { type: 'error' }]);
		expect(result.log).toBe('[error] unknown error\n');
		expect(result.summary.harnessOutcome).toBeUndefined();
		expect(result.summary.pricingEvidence).toMatchObject({
			measurement_status: 'missing',
			terminal_snapshots: 0
		});
		const lines: string[] = [];
		const renderer = new CodexStreamRenderer((line) => lines.push(line));
		renderer.write('not json\n');
		expect(lines).toEqual(['not json\n']);
	});

	it('replaces cumulative totals and makes nonmonotonic, reroute, and unfinished work sticky', () => {
		const result = collect([
			{ type: 'thread.started', thread_id: 'a' },
			{
				type: 'turn.completed',
				usage: {
					input_tokens: 10,
					cached_input_tokens: 2,
					cache_write_input_tokens: 1,
					output_tokens: 4
				}
			},
			{
				type: 'turn.completed',
				usage: {
					input_tokens: 20,
					cached_input_tokens: 3,
					cache_write_input_tokens: 2,
					output_tokens: 6
				}
			},
			{
				type: 'turn.completed',
				usage: {
					input_tokens: 19,
					cached_input_tokens: 3,
					cache_write_input_tokens: 2,
					output_tokens: 6
				}
			},
			{ type: 'item.completed', item: { type: 'error', message: 'model rerouted: overloaded' } },
			{ type: 'turn.started' }
		]);
		expect(result.summary.usage).toEqual({
			input_tokens: 14,
			cache_read_tokens: 3,
			cache_write_tokens: 2,
			output_tokens: 6
		});
		expect(result.summary.pricingEvidence).toMatchObject({
			measurement_status: 'nonmonotonic',
			model_rerouted: true,
			terminal_snapshots: 3
		});
	});

	it('rejects a decrease in derived uncached input even when every raw counter increases', () => {
		const result = collect([
			{
				type: 'turn.completed',
				usage: {
					input_tokens: 10,
					cached_input_tokens: 2,
					cache_write_input_tokens: 1,
					output_tokens: 4
				}
			},
			{
				type: 'turn.completed',
				usage: {
					input_tokens: 11,
					cached_input_tokens: 4,
					cache_write_input_tokens: 1,
					output_tokens: 5
				}
			}
		]);
		expect(result.summary.usage?.input_tokens).toBe(6);
		expect(result.summary.pricingEvidence?.measurement_status).toBe('nonmonotonic');
	});

	it('accepts equal derived uncached input when cumulative cache and output counters increase', () => {
		const result = collect([
			{
				type: 'turn.completed',
				usage: {
					input_tokens: 10,
					cached_input_tokens: 2,
					cache_write_input_tokens: 1,
					output_tokens: 4
				}
			},
			{
				type: 'turn.completed',
				usage: {
					input_tokens: 12,
					cached_input_tokens: 4,
					cache_write_input_tokens: 1,
					output_tokens: 5
				}
			}
		]);
		expect(result.summary.usage).toEqual({
			input_tokens: 7,
			cache_read_tokens: 4,
			cache_write_tokens: 1,
			output_tokens: 5
		});
		expect(result.summary.pricingEvidence?.measurement_status).toBe('complete');
	});

	it('only accepts a structured error item as reroute evidence', () => {
		const result = collect([
			{ type: 'item.completed', item: { type: 'agent_message', text: 'model rerouted: prose' } },
			{
				type: 'item.completed',
				item: { type: 'command_execution', aggregated_output: 'model rerouted: tool output' }
			}
		]);
		expect(result.summary.pricingEvidence?.model_rerouted).toBe(false);
	});
});

describe('classifyCodexFailure', () => {
	it.each<[string, string, number | undefined]>([
		[
			'September, ASCII apostrophe',
			LIMIT_SEPTEMBER,
			new Date(2026, 8, 19, 5, 1).getTime() + MINUTE
		],
		['0.156.1, dated', LIMIT_DATED, new Date(2026, 9, 7, 14, 58).getTime() + MINUTE],
		['0.156.1, same day', LIMIT_SAME_DAY, new Date(2026, 9, 4, 15, 6).getTime() + MINUTE],
		[
			'capitalised "Try again at"',
			'You’ve hit your usage limit. Try again at 3:06 PM.',
			new Date(2026, 9, 4, 15, 6).getTime() + MINUTE
		],
		[
			'12 AM is midnight',
			`You’ve hit your usage limit. ${VISIT} or try again at Oct 7th, 2026 12:05 AM.`,
			new Date(2026, 9, 7, 0, 5).getTime() + MINUTE
		],
		[
			'12 PM is noon',
			'You’ve hit your usage limit. Try again at 12:05 PM.',
			new Date(2026, 9, 4, 12, 5).getTime() + MINUTE
		],
		['no reset named', LIMIT_NO_RESET, undefined],
		[
			'a per-model limit',
			'You’ve hit your usage limit for gpt-6-luna. Try again later.',
			undefined
		],
		['quota exceeded', 'Quota exceeded. Check your plan and billing details.', undefined],
		[
			'a date that does not exist',
			`You’ve hit your usage limit. ${VISIT} or try again at Feb 31st, 2026 9:00 AM.`,
			undefined
		],
		[
			'a time that does not exist',
			`You’ve hit your usage limit. ${VISIT} or try again at 13:75 PM.`,
			undefined
		],
		[
			'a month that does not exist',
			`You’ve hit your usage limit. ${VISIT} or try again at Foo 7th, 2026 2:58 PM.`,
			undefined
		]
	])('a usage limit holds the runner: %s', (_name, message, resumeAt) => {
		// Exact equality: an absent reset is an absent key, not `undefined`.
		expect(classifyCodexFailure(message, NOW)).toEqual({
			kind: 'rate_limited',
			detail: message,
			...(resumeAt !== undefined ? { resumeAt } : {})
		});
		expect('resumeAt' in classifyCodexFailure(message, NOW)!).toBe(resumeAt !== undefined);
	});

	it.each([CAPACITY, HIGH_DEMAND, "We're currently experiencing high demand."])(
		'a provider failure is transient: %s',
		(message) => {
			expect(classifyCodexFailure(message, NOW)).toEqual({
				kind: 'provider_error',
				detail: message
			});
		}
	);

	it.each([
		"The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.",
		// Codex embeds provider response bodies in its other errors.
		'unexpected status 400 Bad Request: {"detail":"You’ve hit your usage limit."}',
		`stream disconnected: ${CAPACITY}`,
		'Quota exceeded for this tool call',
		''
	])('anything else stays a plain failure: %s', (message) => {
		expect(classifyCodexFailure(message, NOW)).toBeUndefined();
	});

	it('clips a long message and ignores surrounding whitespace', () => {
		const outcome = classifyCodexFailure(`  ${CAPACITY} ${'x'.repeat(600)}\n`, NOW);
		expect(outcome?.kind).toBe('provider_error');
		expect(outcome && 'detail' in outcome ? outcome.detail.length : 0).toBeLessThanOrEqual(501);
	});
});

describe('parseCodexResetTime', () => {
	it('reports the end of the printed minute, so a refusal inside it is not already past', () => {
		const printed = new Date(2026, 9, 4, 14, 56).getTime();
		const refusedAt = printed + 40_000;
		const resumeAt = parseCodexResetTime('or try again at 2:56 PM.', refusedAt);
		expect(resumeAt).toBe(printed + MINUTE);
		expect(resumeAt!).toBeGreaterThan(refusedAt);
	});

	it('reads a time-only reset on the local date of the clock it is given', () => {
		expect(parseCodexResetTime(LIMIT_SAME_DAY, new Date(2027, 0, 2, 9, 0).getTime())).toBe(
			new Date(2027, 0, 2, 15, 6).getTime() + MINUTE
		);
	});

	it('returns null when no time is named', () => {
		expect(parseCodexResetTime(LIMIT_NO_RESET, NOW)).toBeNull();
		expect(parseCodexResetTime('try again at some point', NOW)).toBeNull();
		expect(parseCodexResetTime('try again at 0:30 AM.', NOW)).toBeNull();
	});
});

describe('CodexStreamRenderer provider refusal', () => {
	it('reports a usage limit from the failed turn and still logs both error lines', () => {
		const result = collect(refusal(LIMIT_DATED), () => NOW);
		expect(result.summary.harnessOutcome).toEqual({
			kind: 'rate_limited',
			detail: LIMIT_DATED,
			resumeAt: new Date(2026, 9, 7, 14, 58).getTime() + MINUTE
		});
		expect(result.log.match(/^\[error\] You’ve hit your usage limit/gm)).toHaveLength(2);
	});

	it('reports a provider failure from the failed turn', () => {
		expect(collect(refusal(CAPACITY)).summary.harnessOutcome).toEqual({
			kind: 'provider_error',
			detail: CAPACITY
		});
	});

	it('reads the failed turn alone, without the top-level error before it', () => {
		expect(
			collect([{ type: 'turn.started' }, { type: 'turn.failed', error: { message: CAPACITY } }])
				.summary.harnessOutcome
		).toEqual({ kind: 'provider_error', detail: CAPACITY });
	});

	it('uses the injected clock for a same-day reset', () => {
		const result = collect(refusal(LIMIT_SAME_DAY), () => new Date(2027, 0, 2, 9, 0).getTime());
		expect(result.summary.harnessOutcome).toMatchObject({
			resumeAt: new Date(2027, 0, 2, 15, 6).getTime() + MINUTE
		});
	});

	it('never reads an agent message or an error item: an agent cannot talk the runner into a hold', () => {
		expect(
			collect([
				{ type: 'turn.started' },
				{ type: 'item.completed', item: { type: 'agent_message', text: LIMIT_DATED } }
			]).summary.harnessOutcome
		).toBeUndefined();
		expect(
			collect([
				{ type: 'turn.started' },
				{ type: 'item.completed', item: { type: 'error', message: LIMIT_DATED } },
				{
					type: 'item.completed',
					item: { type: 'command_execution', command: 'cat', aggregated_output: CAPACITY }
				}
			]).summary.harnessOutcome
		).toBeUndefined();
	});

	it('drops a top-level error the stream carried on from', () => {
		for (const type of ['item.started', 'item.updated', 'item.completed']) {
			expect(
				collect([
					{ type: 'turn.started' },
					{ type: 'error', message: CAPACITY },
					{ type, item: { type: 'agent_message', text: 'Recovered.' } }
				]).summary.harnessOutcome
			).toBeUndefined();
		}
	});

	it('keeps a top-level error that was the last thing the stream said', () => {
		expect(
			collect([{ type: 'turn.started' }, { type: 'error', message: CAPACITY }]).summary
				.harnessOutcome
		).toEqual({ kind: 'provider_error', detail: CAPACITY });
	});

	it('keeps the failed turn over an unclassified error that follows it', () => {
		expect(
			collect([...refusal(LIMIT_NO_RESET), { type: 'error', message: 'exiting' }]).summary
				.harnessOutcome
		).toEqual({ kind: 'rate_limited', detail: LIMIT_NO_RESET });
	});

	it('forgets a failed turn once a later turn starts or completes', () => {
		expect(
			collect([...refusal(LIMIT_DATED), { type: 'turn.started' }, { type: 'turn.completed' }])
				.summary.harnessOutcome
		).toBeUndefined();
		expect(
			collect([...refusal(LIMIT_DATED), { type: 'turn.started' }]).summary.harnessOutcome
		).toBeUndefined();
		expect(
			collect([...refusal(LIMIT_DATED), { type: 'turn.completed' }]).summary.harnessOutcome
		).toBeUndefined();
	});

	it('replaces a refused turn with a later turn that failed for another reason', () => {
		expect(
			collect([
				...refusal(LIMIT_DATED),
				{ type: 'turn.failed', error: { message: 'model is not supported' } }
			]).summary.harnessOutcome
		).toBeUndefined();
	});

	it('returns a defensive copy of the outcome', () => {
		const renderer = new CodexStreamRenderer(() => {});
		renderer.write(
			refusal(CAPACITY)
				.map((event) => JSON.stringify(event))
				.join('\n')
		);
		renderer.finish();
		(renderer.summary().harnessOutcome as { detail: string }).detail = 'changed';
		expect(renderer.summary().harnessOutcome).toEqual({ kind: 'provider_error', detail: CAPACITY });
	});
});

describe('renderCodexEvent', () => {
	it('renders failed commands with useful context', () => {
		expect(
			renderCodexEvent({
				type: 'item.completed',
				item: {
					type: 'command_execution',
					command: 'pnpm test',
					exit_code: 1,
					aggregated_output: 'red'
				}
			})
		).toEqual(['[tool] pnpm test (exit 1: red)']);
	});
});
