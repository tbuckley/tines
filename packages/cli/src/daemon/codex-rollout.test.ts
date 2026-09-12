import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import {
	CODEX_ROLLOUT_MAX_LINE_BYTES,
	collectCodexRequestContext,
	readCodexRolloutRecords,
	reconcileCodexRollout,
	resolveCodexHome
} from './codex-rollout';

const threadId = '01a09350-f9cc-7160-8a73-60d458864a7e';
const zero = {
	input_tokens: 0,
	cached_input_tokens: 0,
	cache_write_input_tokens: 0,
	output_tokens: 0
};
const total1 = {
	input_tokens: 150_000,
	cached_input_tokens: 100_000,
	cache_write_input_tokens: 0,
	output_tokens: 1_000
};
const total2 = {
	input_tokens: 300_000,
	cached_input_tokens: 210_000,
	cache_write_input_tokens: 10_000,
	output_tokens: 3_000
};
const last2 = {
	input_tokens: 150_000,
	cached_input_tokens: 110_000,
	cache_write_input_tokens: 10_000,
	output_tokens: 2_000
};
const meta = (version = '0.153.4') => ({
	type: 'session_meta',
	payload: { id: threadId, source: 'exec', originator: 'codex_exec', cli_version: version }
});
const count = (total: typeof zero, last: typeof zero) => ({
	type: 'event_msg',
	payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } }
});
const roots: string[] = [];
afterEach(async () =>
	Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
);

describe('reconcileCodexRollout', () => {
	it('proves multi-request short-band usage even when the cumulative total is above 272k', () => {
		expect(
			reconcileCodexRollout(
				[meta(), count(total1, total1), count(total1, total1), count(total2, last2)],
				{ threadId, model: 'gpt-5.6-sol', terminalUsage: total2 }
			)
		).toEqual({
			version: 1,
			normalization: 'codex-rollout-delta-v1',
			harness_version: '0.153.4',
			status: 'complete',
			request_count: 2,
			max_request_input_tokens: 150_000,
			reconciled_usage: total2
		});
	});

	it.each([
		[
			[meta(), count(total1, total1), count(total2, { ...last2, output_tokens: 9 })],
			'delta_mismatch'
		],
		[[meta(), count(total1, total1)], 'terminal_mismatch'],
		[[meta('0.154.0'), count(total2, total2)], 'unsupported_version'],
		[
			[meta(), { type: 'turn_context', payload: { model: 'gpt-6-astra' } }, count(total2, total2)],
			'model_mismatch'
		]
	] as const)('fails closed for %s', (records, reason) => {
		expect(
			reconcileCodexRollout(records, { threadId, model: 'gpt-5.6-sol', terminalUsage: total2 })
		).toMatchObject({ reason });
	});

	it('distinguishes no observation from measured zero', () => {
		expect(
			reconcileCodexRollout([meta()], { threadId, model: 'gpt-5.6-sol', terminalUsage: zero })
		).toMatchObject({ status: 'complete', request_count: 0 });
		expect(
			reconcileCodexRollout([meta()], { threadId, model: 'gpt-5.6-sol', terminalUsage: total1 })
		).toMatchObject({ reason: 'missing_dimension' });
	});

	it.each([
		[
			{
				input_tokens: 199_999,
				cached_input_tokens: 100_000,
				cache_write_input_tokens: 10_000,
				output_tokens: 1_000
			}
		],
		[
			{
				input_tokens: 200_000,
				cached_input_tokens: 99_999,
				cache_write_input_tokens: 10_000,
				output_tokens: 1_000
			}
		],
		[
			{
				input_tokens: 200_000,
				cached_input_tokens: 100_000,
				cache_write_input_tokens: 9_999,
				output_tokens: 1_000
			}
		],
		[
			{
				input_tokens: 200_000,
				cached_input_tokens: 100_000,
				cache_write_input_tokens: 10_000,
				output_tokens: 999
			}
		]
	])('rejects a component-wise decrease', (next) => {
		const previous = {
			input_tokens: 200_000,
			cached_input_tokens: 100_000,
			cache_write_input_tokens: 10_000,
			output_tokens: 1_000
		};
		expect(
			reconcileCodexRollout([meta(), count(previous, previous), count(next, zero)], {
				threadId,
				model: 'gpt-5.6-sol',
				terminalUsage: next
			})
		).toMatchObject({ status: 'invalid', reason: 'nonmonotonic' });
	});

	it('rejects a delta whose cache classes exceed its inclusive input', () => {
		const next = {
			input_tokens: 160_000,
			cached_input_tokens: 105_000,
			cache_write_input_tokens: 10_000,
			output_tokens: 2_000
		};
		expect(
			reconcileCodexRollout(
				[
					meta(),
					count(total1, total1),
					count(next, {
						input_tokens: 10_000,
						cached_input_tokens: 5_000,
						cache_write_input_tokens: 10_000,
						output_tokens: 1_000
					})
				],
				{
					threadId,
					model: 'gpt-5.6-sol',
					terminalUsage: next
				}
			)
		).toMatchObject({ status: 'invalid', reason: 'nonmonotonic' });
	});

	it('keeps accounting invalid after later apparently valid snapshots', () => {
		expect(
			reconcileCodexRollout(
				[
					meta(),
					count(total1, total1),
					count(total2, { ...last2, output_tokens: 99 }),
					count(total2, last2)
				],
				{ threadId, model: 'gpt-5.6-sol', terminalUsage: total2 }
			)
		).toMatchObject({ status: 'invalid', reason: 'delta_mismatch' });
	});

	it.each([
		[
			[meta(), count({ ...total1, output_tokens: undefined } as never, total1)],
			'missing_dimension'
		],
		[
			[meta(), count(total1, total1), count(total1, { ...total1, output_tokens: 2 })],
			'delta_mismatch'
		],
		[[meta(), meta(), count(total1, total1)], 'metadata_mismatch'],
		[
			[{ ...meta(), payload: { ...meta().payload, source: 'other' } }, count(total1, total1)],
			'metadata_mismatch'
		]
	] as const)('fails closed for malformed identity/snapshot variants', (records, reason) => {
		expect(
			reconcileCodexRollout(records, { threadId, model: null, terminalUsage: total1 })
		).toMatchObject({ status: 'invalid', reason });
	});
});

describe('readCodexRolloutRecords', () => {
	it('terminates a stalled stream at its deadline', async () => {
		const stalled = new PassThrough();
		const started = Date.now();
		await expect(readCodexRolloutRecords(stalled, 25)).resolves.toEqual({
			reason: 'limit_exceeded'
		});
		expect(Date.now() - started).toBeLessThan(500);
	});

	it.each([
		['not json', 'malformed'],
		[`"${'x'.repeat(CODEX_ROLLOUT_MAX_LINE_BYTES)}"`, 'limit_exceeded']
	])('bounds and validates incremental input', async (body, reason) => {
		await expect(readCodexRolloutRecords(Readable.from([body]), 1_000)).resolves.toEqual({
			reason
		});
	});
});

describe('collectCodexRequestContext', () => {
	it('reads only the exact rollout from the bounded date directory, including an unterminated final line', async () => {
		const root = await mkdtemp(join(tmpdir(), 'codex-rollout-'));
		roots.push(root);
		const directory = join(root, 'sessions', '2026', '09', '12');
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, `rollout-safe-${threadId}.jsonl`),
			[meta(), count(total1, total1), count(total2, last2)]
				.map((record) => JSON.stringify(record))
				.join('\n')
		);
		const result = await collectCodexRequestContext({
			codexHome: root,
			threadId,
			model: 'gpt-5.6-sol',
			startedAt: Date.parse('2026-09-12T10:00:00Z'),
			endedAt: Date.parse('2026-09-12T10:01:00Z'),
			terminalUsage: total2
		});
		expect(result).toMatchObject({
			status: 'complete',
			request_count: 2,
			max_request_input_tokens: 150_000
		});
	});

	it('resolves a relative CODEX_HOME against the child workspace', () => {
		expect(resolveCodexHome({ CODEX_HOME: '../state' }, '/tmp/work/run')).toBe('/tmp/work/state');
	});

	it('rejects ambiguous exact-thread files and symlinks escaping the sessions root', async () => {
		const root = await mkdtemp(join(tmpdir(), 'codex-rollout-'));
		roots.push(root);
		const directory = join(root, 'sessions', '2026', '09', '12');
		await mkdir(directory, { recursive: true });
		const body = [meta(), count(total1, total1)].map((record) => JSON.stringify(record)).join('\n');
		await writeFile(join(directory, `rollout-a-${threadId}.jsonl`), body);
		await writeFile(join(directory, `rollout-b-${threadId}.jsonl`), body);
		const input = {
			codexHome: root,
			threadId,
			model: 'gpt-5.6-sol',
			startedAt: Date.parse('2026-09-12T10:00:00Z'),
			endedAt: Date.parse('2026-09-12T10:01:00Z'),
			terminalUsage: total1
		};
		await expect(collectCodexRequestContext(input)).resolves.toMatchObject({
			reason: 'rollout_ambiguous'
		});
		await rm(join(directory, `rollout-a-${threadId}.jsonl`));
		await rm(join(directory, `rollout-b-${threadId}.jsonl`));
		const outside = join(root, 'outside.jsonl');
		await writeFile(outside, body);
		await symlink(outside, join(directory, `rollout-link-${threadId}.jsonl`));
		await expect(collectCodexRequestContext(input)).resolves.toMatchObject({
			reason: 'unsafe_path'
		});
	});

	it('rejects invalid thread ids and attempt windows wider than the directory cap', async () => {
		const base = {
			codexHome: '/does/not/matter',
			model: null,
			terminalUsage: zero
		};
		await expect(
			collectCodexRequestContext({ ...base, threadId: 'not-a-thread', startedAt: 0, endedAt: 1 })
		).resolves.toMatchObject({ reason: 'thread_id_missing' });
		await expect(
			collectCodexRequestContext({
				...base,
				threadId,
				startedAt: Date.parse('2026-01-01T00:00:00Z'),
				endedAt: Date.parse('2026-02-01T00:00:00Z')
			})
		).resolves.toMatchObject({ reason: 'limit_exceeded' });
	});
});
