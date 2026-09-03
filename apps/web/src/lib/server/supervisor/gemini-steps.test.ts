import { describe, expect, it } from 'vitest';
import {
	judgeInteraction,
	mapGeminiUsage,
	renderStep,
	summarizeSteps,
	type GeminiStep
} from './gemini-steps';

describe('mapGeminiUsage', () => {
	it('prices tokens from the table: cached at the cache rate, thoughts at the output rate', () => {
		const usage = mapGeminiUsage(
			{
				total_input_tokens: 1_000_000,
				total_output_tokens: 100_000,
				total_thought_tokens: 50_000,
				total_cached_tokens: 200_000,
				total_tokens: 1_150_000
			},
			'gemini-3.8-flash'
		);
		expect(usage).toEqual({
			input_tokens: 1_000_000,
			output_tokens: 100_000,
			thought_tokens: 50_000,
			cache_read_tokens: 200_000,
			cost_source: 'priced',
			// 800k uncached × 0.75 + 200k cached × 0.075 + 150k output × 3.75, per Mtok
			cost_usd: 0.6 + 0.015 + 0.5625
		});
	});

	it('records tokens without dollars for a model the table does not know', () => {
		const usage = mapGeminiUsage({ total_input_tokens: 10, total_output_tokens: 5 }, 'gemini-9');
		expect(usage).toEqual({ input_tokens: 10, output_tokens: 5, cost_source: 'priced' });
		expect(usage.cost_usd).toBeUndefined();
	});

	it('zeroes an absent usage block rather than leaving fields undefined', () => {
		expect(mapGeminiUsage(undefined, 'gemini-3.8-flash')).toEqual({
			input_tokens: 0,
			output_tokens: 0,
			cost_source: 'priced',
			cost_usd: 0
		});
	});
});

describe('renderStep', () => {
	it('renders agent text, tool calls, and tool errors; skips thoughts and quiet results', () => {
		expect(
			renderStep({ type: 'model_output', content: [{ type: 'text', text: 'Working on it' }] })
		).toBe('[agent] Working on it');
		expect(
			renderStep({ type: 'function_call', id: 'c1', name: 'bash', arguments: { command: 'ls' } })
		).toBe('[tool] bash {"command":"ls"}');
		expect(
			renderStep({ type: 'function_result', call_id: 'c1', is_error: true, result: 'boom' })
		).toBe('[tool] error: boom');
		expect(renderStep({ type: 'function_result', call_id: 'c1', result: 'fine' })).toBeNull();
		expect(renderStep({ type: 'thought', summary: [{ type: 'text', text: 'hmm' }] })).toBeNull();
		expect(renderStep({ type: 'processing_call', id: 'p1' } as GeminiStep)).toBeNull();
		expect(renderStep({ type: 'user_input', content: [{ type: 'text', text: 'hello' }] })).toBe(
			'[user] message delivered (5 chars)'
		);
	});

	it('surfaces a model_output error as an error line', () => {
		expect(renderStep({ type: 'model_output', error: { code: 8, message: 'quota' } })).toBe(
			'[error] quota'
		);
	});
});

describe('summarizeSteps', () => {
	it('renders only the steps past the cursor and carries the last error', () => {
		const steps: GeminiStep[] = [
			{ type: 'user_input', content: [{ type: 'text', text: 'go' }] },
			{ type: 'model_output', content: [{ type: 'text', text: 'first' }] },
			{ type: 'model_output', content: [{ type: 'text', text: 'second' }] },
			{ type: 'model_output', error: { message: 'exploded' } }
		];
		const summary = summarizeSteps(steps, 2);
		expect(summary.lines).toEqual(['[agent] second', '[error] exploded']);
		expect(summary.lastError).toBe('exploded');
	});
});

describe('judgeInteraction', () => {
	it('maps terminal statuses to run ends and leaves live ones alone', () => {
		expect(judgeInteraction({ status: 'in_progress' }, undefined)).toBeNull();
		expect(judgeInteraction({ status: 'queued' }, undefined)).toBeNull();
		expect(judgeInteraction({ status: 'completed' }, undefined)).toEqual({
			status: 'completed',
			error: null
		});
		expect(judgeInteraction({ status: 'cancelled' }, undefined)).toEqual({
			status: 'canceled',
			error: null
		});
		expect(judgeInteraction({ status: 'failed', errors: [{ message: 'bad' }] }, 'older')).toEqual({
			status: 'failed',
			error: 'bad'
		});
		expect(judgeInteraction({ status: 'failed' }, 'older')).toEqual({
			status: 'failed',
			error: 'older'
		});
		expect(judgeInteraction({ status: 'budget_exceeded' }, undefined)?.error).toMatch(/token cap/);
		expect(judgeInteraction({ status: 'requires_action' }, undefined)?.error).toMatch(
			/tool result/
		);
		expect(judgeInteraction({ status: 'incomplete' }, undefined)?.status).toBe('failed');
	});
});
