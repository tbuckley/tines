import { describe, expect, it } from 'vitest';
import { ClaudeStreamRenderer, renderStreamEvent } from './claude-stream';

/**
 * Fixtures follow the shape `claude -p --output-format stream-json --verbose`
 * actually emits (probed against Claude Code 2.1.247 while researching
 * Tines/66), trimmed to the fields the renderer reads.
 */

function render(events: unknown[]): string {
	const out: string[] = [];
	const renderer = new ClaudeStreamRenderer((line) => out.push(line));
	renderer.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
	renderer.finish();
	return out.join('');
}

describe('renderStreamEvent', () => {
	it('announces the session with its model', () => {
		expect(renderStreamEvent({ type: 'system', subtype: 'init', model: 'claude-opus-5' })).toEqual([
			'[session] started (model claude-opus-5)'
		]);
	});

	it('renders assistant text as [agent]', () => {
		expect(
			renderStreamEvent({
				type: 'assistant',
				message: { content: [{ type: 'text', text: '  Looking at the config.  ' }] }
			})
		).toEqual(['[agent] Looking at the config.']);
	});

	it('renders a tool call with its input — the shell command is the point', () => {
		expect(
			renderStreamEvent({
				type: 'assistant',
				message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] }
			})
		).toEqual(['[tool] Bash {"command":"ls -la"}']);
	});

	it('renders every block of a multi-block message, in order', () => {
		expect(
			renderStreamEvent({
				type: 'assistant',
				message: {
					content: [
						{ type: 'text', text: 'First I will look.' },
						{ type: 'tool_use', name: 'Read', input: { file_path: '/etc/hosts' } }
					]
				}
			})
		).toEqual(['[agent] First I will look.', '[tool] Read {"file_path":"/etc/hosts"}']);
	});

	it('drops thinking blocks and the noise events, which the raw log keeps', () => {
		expect(
			renderStreamEvent({
				type: 'assistant',
				message: { content: [{ type: 'thinking', text: 'hmm' }] }
			})
		).toEqual([]);
		expect(renderStreamEvent({ type: 'system', subtype: 'thinking_tokens' })).toEqual([]);
		expect(renderStreamEvent({ type: 'rate_limit_event' })).toEqual([]);
	});

	it('reports only failed tool results', () => {
		expect(
			renderStreamEvent({
				type: 'user',
				message: { content: [{ type: 'tool_result', content: 'ok, lots of output' }] }
			})
		).toEqual([]);
		expect(
			renderStreamEvent({
				type: 'user',
				message: {
					content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'no such file' }] }]
				}
			})
		).toEqual(['[tool] error: no such file']);
	});

	it('summarizes the result, and surfaces the reason when it failed', () => {
		expect(
			renderStreamEvent({ type: 'result', subtype: 'success', num_turns: 12, total_cost_usd: 0.4213 })
		).toEqual(['[session] result: success (12 turns, $0.42)']);
		expect(
			renderStreamEvent({
				type: 'result',
				subtype: 'error_max_turns',
				is_error: true,
				result: 'hit the turn limit'
			})
		).toEqual(['[session] result: error_max_turns', '[error] hit the turn limit']);
	});

	it('clips a long tool input rather than dropping it', () => {
		const [line] = renderStreamEvent({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(1000) } }] }
		});
		expect(line!.length).toBeLessThan(340);
		expect(line!.endsWith('…')).toBe(true);
	});
});

describe('ClaudeStreamRenderer', () => {
	it('renders a whole session into readable prose', () => {
		expect(
			render([
				{ type: 'system', subtype: 'init', model: 'claude-opus-5' },
				{ type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } },
				{
					type: 'assistant',
					message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] }
				},
				{ type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.01 }
			])
		).toBe(
			'[session] started (model claude-opus-5)\n' +
				'[agent] On it.\n' +
				'[tool] Bash {"command":"pnpm test"}\n' +
				'[session] result: success (2 turns, $0.01)\n'
		);
	});

	it('reassembles an event split across chunk boundaries', () => {
		const out: string[] = [];
		const renderer = new ClaudeStreamRenderer((line) => out.push(line));
		const json = JSON.stringify({
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'split across writes' }] }
		});
		// The pipe splits wherever it likes; a half-written event must not
		// render as a garbage passthrough line.
		renderer.write(json.slice(0, 20));
		expect(out).toEqual([]);
		renderer.write(json.slice(20) + '\n');
		expect(out).toEqual(['[agent] split across writes\n']);
	});

	it('renders a trailing line with no newline once the harness exits', () => {
		const out: string[] = [];
		const renderer = new ClaudeStreamRenderer((line) => out.push(line));
		renderer.write(JSON.stringify({ type: 'result', subtype: 'success' }));
		expect(out).toEqual([]);
		renderer.finish();
		expect(out).toEqual(['[session] result: success\n']);
	});

	it('passes non-JSON through verbatim, so an older claude still logs', () => {
		const out: string[] = [];
		const renderer = new ClaudeStreamRenderer((line) => out.push(line));
		renderer.write('plain old output\nerror: something broke\n');
		expect(out).toEqual(['plain old output\n', 'error: something broke\n']);
	});

	it('passes a malformed JSON line through rather than losing it', () => {
		const out: string[] = [];
		const renderer = new ClaudeStreamRenderer((line) => out.push(line));
		renderer.write('{"type":"assistant", truncated\n');
		expect(out).toEqual(['{"type":"assistant", truncated\n']);
	});

	it('ignores blank lines', () => {
		const out: string[] = [];
		const renderer = new ClaudeStreamRenderer((line) => out.push(line));
		renderer.write('\n\n  \n');
		renderer.finish();
		expect(out).toEqual([]);
	});
});
