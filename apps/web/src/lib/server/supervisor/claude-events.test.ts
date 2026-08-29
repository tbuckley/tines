import { describe, expect, it } from 'vitest';
import type { BetaManagedAgentsSessionUsage } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
import type { BetaManagedAgentsSessionEvent } from '@anthropic-ai/sdk/resources/beta/sessions/events';
import { clip, mapUsage, renderEvent, textOf } from './claude-events';

/** Provider event shapes are wider than any one branch needs; build them loosely. */
const ev = (obj: Record<string, unknown>) => obj as unknown as BetaManagedAgentsSessionEvent;
const text = (t: string) => [{ type: 'text', text: t }];
const usage = (obj: Record<string, unknown>) => obj as unknown as BetaManagedAgentsSessionUsage;

describe('renderEvent', () => {
	// One row per `switch` branch, including both null paths.
	const cases: Array<[name: string, event: BetaManagedAgentsSessionEvent, expected: string | null]> = [
		[
			'user.message counts the delivered characters',
			ev({ type: 'user.message', content: text('hello') }),
			'[user] message delivered (5 chars)'
		],
		[
			'user.message with no content is 0 chars',
			ev({ type: 'user.message' }),
			'[user] message delivered (0 chars)'
		],
		[
			'agent.message renders its text',
			ev({ type: 'agent.message', content: text('  working on it  ') }),
			'[agent] working on it'
		],
		['agent.message with empty text is dropped', ev({ type: 'agent.message', content: text('   ') }), null],
		['agent.message with no content is dropped', ev({ type: 'agent.message' }), null],
		[
			'agent.tool_use renders name and JSON args',
			ev({ type: 'agent.tool_use', name: 'Bash', input: { command: 'ls' } }),
			'[tool] Bash {"command":"ls"}'
		],
		[
			'agent.tool_use without name or input falls back to "tool" and empty args',
			ev({ type: 'agent.tool_use' }),
			'[tool] tool '
		],
		[
			'agent.mcp_tool_use renders like a tool use',
			ev({ type: 'agent.mcp_tool_use', name: 'mcp__x__y', input: { a: 1 } }),
			'[tool] mcp__x__y {"a":1}'
		],
		['agent.tool_result without an error is dropped', ev({ type: 'agent.tool_result', content: text('ok') }), null],
		[
			'agent.tool_result with is_error false is dropped',
			ev({ type: 'agent.tool_result', is_error: false, content: text('ok') }),
			null
		],
		[
			'agent.tool_result with is_error renders the text',
			ev({ type: 'agent.tool_result', is_error: true, content: text('boom') }),
			'[tool] error: boom'
		],
		['agent.mcp_tool_result without an error is dropped', ev({ type: 'agent.mcp_tool_result' }), null],
		[
			'agent.mcp_tool_result with is_error renders the text',
			ev({ type: 'agent.mcp_tool_result', is_error: true, content: text('nope') }),
			'[tool] error: nope'
		],
		[
			'session.error renders the provider message',
			ev({ type: 'session.error', error: { message: 'overloaded' } }),
			'[error] overloaded'
		],
		['session.error without a message falls back', ev({ type: 'session.error' }), '[error] unknown session error'],
		['session.status_running', ev({ type: 'session.status_running' }), '[session] running'],
		[
			'session.status_idle names its stop reason',
			ev({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }),
			'[session] idle (end_turn)'
		],
		[
			'session.status_idle without a stop reason is unknown',
			ev({ type: 'session.status_idle' }),
			'[session] idle (unknown)'
		],
		['session.status_terminated', ev({ type: 'session.status_terminated' }), '[session] terminated'],
		['agent.thread_context_compacted', ev({ type: 'agent.thread_context_compacted' }), '[session] context compacted'],
		['an unknown event type is dropped', ev({ type: 'session.something_new' }), null]
	];

	it.each(cases)('%s', (_name, event, expected) => {
		expect(renderEvent(event)).toBe(expected);
	});

	it('clips agent text at 2000 characters', () => {
		const line = renderEvent(ev({ type: 'agent.message', content: text('a'.repeat(2500)) }));
		expect(line).toBe(`[agent] ${'a'.repeat(2000)}…`);
	});

	it('leaves agent text of exactly 2000 characters intact', () => {
		const line = renderEvent(ev({ type: 'agent.message', content: text('a'.repeat(2000)) }));
		expect(line).toBe(`[agent] ${'a'.repeat(2000)}`);
	});

	it('clips tool arguments at 300 characters', () => {
		const line = renderEvent(ev({ type: 'agent.tool_use', name: 'Write', input: { body: 'x'.repeat(400) } }));
		const args = JSON.stringify({ body: 'x'.repeat(400) });
		expect(line).toBe(`[tool] Write ${args.slice(0, 300)}…`);
	});

	it('clips tool error text at 300 characters', () => {
		const line = renderEvent(ev({ type: 'agent.tool_result', is_error: true, content: text('e'.repeat(400)) }));
		expect(line).toBe(`[tool] error: ${'e'.repeat(300)}…`);
	});
});

describe('mapUsage', () => {
	it('reports zeros for absent usage and nothing else', () => {
		expect(mapUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0, cost_source: 'provider' });
	});

	it('carries input and output tokens through', () => {
		expect(mapUsage(usage({ input_tokens: 12, output_tokens: 34 }))).toEqual({
			input_tokens: 12,
			output_tokens: 34,
			cost_source: 'provider'
		});
	});

	it('sums both ephemeral cache-creation buckets', () => {
		const out = mapUsage(
			usage({ cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 25 } })
		);
		expect(out.cache_write_tokens).toBe(125);
	});

	it('accepts a single cache bucket', () => {
		expect(mapUsage(usage({ cache_creation: { ephemeral_5m_input_tokens: 7 } })).cache_write_tokens).toBe(7);
		expect(mapUsage(usage({ cache_creation: { ephemeral_1h_input_tokens: 9 } })).cache_write_tokens).toBe(9);
	});

	it('reports cache reads', () => {
		expect(mapUsage(usage({ cache_read_input_tokens: 42 })).cache_read_tokens).toBe(42);
	});

	it('omits zero cache values rather than emitting 0', () => {
		const out = mapUsage(
			usage({
				cache_read_input_tokens: 0,
				cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }
			})
		);
		expect(out).not.toHaveProperty('cache_read_tokens');
		expect(out).not.toHaveProperty('cache_write_tokens');
	});

	it('converts list_cost cents to dollars', () => {
		expect(mapUsage(usage({ list_cost: { amount: '123', currency: 'USD' } })).cost_usd).toBe(1.23);
		expect(mapUsage(usage({ list_cost: { amount: '5', currency: 'USD' } })).cost_usd).toBe(0.05);
		// '0' is a truthy string, so a zero cost is reported rather than omitted.
		expect(mapUsage(usage({ list_cost: { amount: '0', currency: 'USD' } })).cost_usd).toBe(0);
	});

	it('omits cost_usd when the provider reports no list_cost', () => {
		expect(mapUsage(usage({ input_tokens: 1 }))).not.toHaveProperty('cost_usd');
		expect(mapUsage(usage({ list_cost: { amount: '', currency: 'USD' } }))).not.toHaveProperty('cost_usd');
	});
});

describe('textOf', () => {
	it('is empty for absent content', () => {
		expect(textOf(undefined)).toBe('');
	});

	it('concatenates text blocks and skips the rest', () => {
		expect(textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('ab');
	});

	it('trims the surrounding whitespace', () => {
		expect(textOf([{ type: 'text', text: '  hi\n' }])).toBe('hi');
	});
});

describe('clip', () => {
	it('leaves a string of exactly max characters alone', () => {
		expect(clip('abcde', 5)).toBe('abcde');
	});

	it('appends a single ellipsis past max', () => {
		expect(clip('abcdef', 5)).toBe('abcde…');
	});
});
