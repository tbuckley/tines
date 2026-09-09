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
				usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100 }
			}
		]);
		expect(result.log).toContain('[agent] Done.');
		expect(result.summary).toEqual({
			providerSessionId: 'thread_123',
			usage: { input_tokens: 400, cache_read_tokens: 600, output_tokens: 100 }
		});
	});

	it('clamps cache to total input and keeps independently valid counters', () => {
		expect(
			collect([
				{
					type: 'turn.completed',
					usage: { input_tokens: 5, cached_input_tokens: 9, output_tokens: -1 }
				}
			]).summary.usage
		).toEqual({ input_tokens: 0, cache_read_tokens: 5 });
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
		renderer.write('{"type":"turn.completed","usage":{"input_tokens":4}}\n');
		expect(renderer.summary().usage).toEqual({ input_tokens: 4 });
	});

	it('keeps prose, ignores unknown JSON, and tolerates incomplete errors', () => {
		const result = collect([{ type: 'unknown' }, { type: 'error' }]);
		expect(result.log).toBe('[error] unknown error\n');
		expect(result.summary).toEqual({});
		const lines: string[] = [];
		const renderer = new CodexStreamRenderer((line) => lines.push(line));
		renderer.write('not json\n');
		expect(lines).toEqual(['not json\n']);
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
