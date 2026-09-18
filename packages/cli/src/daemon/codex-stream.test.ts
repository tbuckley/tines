import { describe, expect, it } from 'vitest';
import { CodexStreamRenderer, renderCodexEvent } from './codex-stream.js';

function collect(events: unknown[]) {
	const lines: string[] = [];
	const renderer = new CodexStreamRenderer((line) => lines.push(line));
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
