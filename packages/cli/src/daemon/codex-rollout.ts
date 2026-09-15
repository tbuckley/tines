import { open, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import type { CodexRawUsageV1, CodexRequestContextV1 } from '@tines/shared';
import { isSupportedCodexRolloutVersion } from '@tines/shared';

export const CODEX_ROLLOUT_MAX_BYTES = 128 * 1024 * 1024;
export const CODEX_ROLLOUT_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const CODEX_ROLLOUT_MAX_LINES = 250_000;
export const CODEX_ROLLOUT_MAX_REQUESTS = 10_000;
export const CODEX_ROLLOUT_TIMEOUT_MS = 5_000;
const FIELDS = [
	'input_tokens',
	'cached_input_tokens',
	'cache_write_input_tokens',
	'output_tokens'
] as const;
type Usage = Required<CodexRawUsageV1>;
type FailureReason =
	| 'not_applicable'
	| 'thread_id_missing'
	| 'rollout_missing'
	| 'rollout_ambiguous'
	| 'unsafe_path'
	| 'read_failed'
	| 'limit_exceeded'
	| 'unsupported_version'
	| 'metadata_mismatch'
	| 'malformed'
	| 'missing_dimension'
	| 'nonmonotonic'
	| 'delta_mismatch'
	| 'terminal_mismatch'
	| 'model_mismatch';

const unavailable = (reason: FailureReason): CodexRequestContextV1 => ({
	version: 1,
	normalization: 'codex-rollout-delta-v1',
	status: 'unavailable',
	reason
});
const invalid = (reason: FailureReason, harness_version?: string): CodexRequestContextV1 => ({
	version: 1,
	normalization: 'codex-rollout-delta-v1',
	...(harness_version ? { harness_version: harness_version.slice(0, 100) } : {}),
	status: 'invalid',
	reason
});

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function usage(value: unknown, validateClasses = true): Usage | undefined {
	const raw = object(value);
	if (!raw) return;
	const out = {} as Usage;
	for (const field of FIELDS) {
		const metric = raw[field];
		if (!Number.isSafeInteger(metric) || (metric as number) < 0) return;
		out[field] = metric as number;
	}
	if (validateClasses && out.cached_input_tokens + out.cache_write_input_tokens > out.input_tokens)
		return;
	return out;
}

function equal(a: Usage, b: Usage): boolean {
	return FIELDS.every((field) => a[field] === b[field]);
}

/** Pure accumulator for scrubbed rollout records; any bad accounting is sticky. */
export function reconcileCodexRollout(
	records: readonly unknown[],
	input: { threadId: string; model: string | null; terminalUsage: Usage }
): CodexRequestContextV1 {
	let metadata = false;
	let harnessVersion: string | undefined;
	let observedModel: string | undefined;
	let previous: Usage = {
		input_tokens: 0,
		cached_input_tokens: 0,
		cache_write_input_tokens: 0,
		output_tokens: 0
	};
	let observed = false;
	let requestCount = 0;
	let maxRequestInput = 0;
	let previousLast: Usage = { ...previous };
	for (const value of records) {
		const record = object(value);
		const payload = object(record?.payload);
		if (record?.type === 'session_meta') {
			if (metadata) return invalid('metadata_mismatch', harnessVersion);
			harnessVersion = typeof payload?.cli_version === 'string' ? payload.cli_version : undefined;
			if (
				payload?.id !== input.threadId ||
				payload?.source !== 'exec' ||
				payload?.originator !== 'codex_exec'
			)
				return invalid('metadata_mismatch', harnessVersion);
			metadata = true;
			continue;
		}
		if (record?.type === 'turn_context' && typeof payload?.model === 'string') {
			observedModel ??= payload.model;
			if (observedModel !== payload.model || (input.model && payload.model !== input.model))
				return invalid('model_mismatch', harnessVersion);
			continue;
		}
		if (record?.type !== 'event_msg' || payload?.type !== 'token_count') continue;
		const info = object(payload.info);
		if (!info) continue;
		const total = usage(info.total_token_usage);
		const last = usage(info.last_token_usage, false);
		if (!total || !last) return invalid('missing_dimension', harnessVersion);
		observed = true;
		if (equal(total, previous)) {
			if (!equal(last, previousLast)) return invalid('delta_mismatch', harnessVersion);
			continue;
		}
		if (FIELDS.some((field) => total[field] < previous[field]))
			return invalid('nonmonotonic', harnessVersion);
		const delta = {} as Usage;
		for (const field of FIELDS) delta[field] = total[field] - previous[field];
		if (delta.cached_input_tokens + delta.cache_write_input_tokens > delta.input_tokens)
			return invalid('nonmonotonic', harnessVersion);
		if (!equal(delta, last)) return invalid('delta_mismatch', harnessVersion);
		requestCount++;
		if (requestCount > CODEX_ROLLOUT_MAX_REQUESTS) return invalid('limit_exceeded', harnessVersion);
		maxRequestInput = Math.max(maxRequestInput, delta.input_tokens);
		previous = total;
		previousLast = delta;
	}
	if (!metadata) return invalid('metadata_mismatch', harnessVersion);
	if (!harnessVersion || !isSupportedCodexRolloutVersion(harnessVersion)) {
		return {
			version: 1,
			normalization: 'codex-rollout-delta-v1',
			...(harnessVersion ? { harness_version: harnessVersion.slice(0, 100) } : {}),
			status: 'unsupported',
			reason: 'unsupported_version'
		};
	}
	const terminalZero = FIELDS.every((field) => input.terminalUsage[field] === 0);
	if (!observed && !terminalZero) return invalid('missing_dimension', harnessVersion);
	if (!equal(previous, input.terminalUsage)) return invalid('terminal_mismatch', harnessVersion);
	return {
		version: 1,
		normalization: 'codex-rollout-delta-v1',
		harness_version: harnessVersion,
		status: 'complete',
		request_count: requestCount,
		max_request_input_tokens: maxRequestInput,
		reconciled_usage: { ...previous }
	};
}

export function resolveCodexHome(env: NodeJS.ProcessEnv, workspace: string): string {
	const configured = env.CODEX_HOME;
	return configured ? resolve(workspace, configured) : join(homedir(), '.codex');
}

function dateDirectories(startedAt: number, endedAt: number): string[] | null {
	const first = new Date(startedAt);
	first.setUTCDate(first.getUTCDate() - 1);
	first.setUTCHours(0, 0, 0, 0);
	const last = new Date(endedAt);
	last.setUTCDate(last.getUTCDate() + 1);
	last.setUTCHours(0, 0, 0, 0);
	const result: string[] = [];
	for (let date = first; date <= last; date = new Date(date.getTime() + 86_400_000)) {
		result.push(
			join(
				String(date.getUTCFullYear()),
				String(date.getUTCMonth() + 1).padStart(2, '0'),
				String(date.getUTCDate()).padStart(2, '0')
			)
		);
		if (result.length > 10) return null;
	}
	return result;
}

type BoundedRead =
	{ records: unknown[] } | { reason: 'limit_exceeded' | 'malformed' | 'read_failed' };

/** Incremental JSONL reader: the deadline also destroys a stalled filesystem stream. */
export async function readCodexRolloutRecords(
	stream: Readable,
	timeoutMs: number
): Promise<BoundedRead> {
	let timedOut = false;
	const timer = setTimeout(
		() => {
			timedOut = true;
			stream.destroy(new Error('Codex rollout read deadline exceeded'));
		},
		Math.max(0, timeoutMs)
	);
	const decoder = new StringDecoder('utf8');
	let pending = '';
	let bytes = 0;
	let lines = 0;
	const records: unknown[] = [];
	const consume = (line: string): BoundedRead | undefined => {
		if (++lines > CODEX_ROLLOUT_MAX_LINES || Buffer.byteLength(line) > CODEX_ROLLOUT_MAX_LINE_BYTES)
			return { reason: 'limit_exceeded' };
		if (!line.trim()) return;
		try {
			records.push(JSON.parse(line));
		} catch {
			return { reason: 'malformed' };
		}
	};
	try {
		for await (const value of stream) {
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
			bytes += chunk.length;
			if (bytes > CODEX_ROLLOUT_MAX_BYTES) return { reason: 'limit_exceeded' };
			pending += decoder.write(chunk);
			let newline: number;
			while ((newline = pending.indexOf('\n')) >= 0) {
				const failure = consume(pending.slice(0, newline));
				if (failure) return failure;
				pending = pending.slice(newline + 1);
			}
			if (Buffer.byteLength(pending) > CODEX_ROLLOUT_MAX_LINE_BYTES)
				return { reason: 'limit_exceeded' };
		}
		pending += decoder.end();
		if (pending.length) {
			const failure = consume(pending);
			if (failure) return failure;
		}
		return { records };
	} catch {
		return { reason: timedOut ? 'limit_exceeded' : 'read_failed' };
	} finally {
		clearTimeout(timer);
		stream.destroy();
	}
}

export async function collectCodexRequestContext(input: {
	codexHome: string;
	threadId: string;
	model: string | null;
	startedAt: number;
	endedAt: number;
	terminalUsage: Usage;
}): Promise<CodexRequestContextV1> {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.threadId))
		return unavailable('thread_id_missing');
	const dates = dateDirectories(input.startedAt, input.endedAt);
	if (!dates) return unavailable('limit_exceeded');
	const sessions = join(input.codexHome, 'sessions');
	let root: string;
	try {
		root = await realpath(sessions);
	} catch {
		return unavailable('rollout_missing');
	}
	const candidates: string[] = [];
	let entries = 0;
	const deadline = Date.now() + CODEX_ROLLOUT_TIMEOUT_MS;
	try {
		for (const date of dates) {
			const directory = join(root, date);
			let stream;
			try {
				stream = await opendir(directory);
			} catch {
				continue;
			}
			for await (const entry of stream) {
				if (++entries > 20_000 || Date.now() > deadline) return unavailable('limit_exceeded');
				if (
					(entry.isFile() || entry.isSymbolicLink()) &&
					entry.name.startsWith('rollout-') &&
					entry.name.endsWith(`-${input.threadId}.jsonl`)
				)
					candidates.push(join(directory, entry.name));
			}
		}
		if (candidates.length === 0) return unavailable('rollout_missing');
		if (candidates.length !== 1) return unavailable('rollout_ambiguous');
		const candidate = await realpath(candidates[0]!);
		const inside = relative(root, candidate);
		if (inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside))
			return unavailable('unsafe_path');
		const before = await stat(candidate);
		if (!before.isFile() || before.size > CODEX_ROLLOUT_MAX_BYTES)
			return unavailable('limit_exceeded');
		const handle = await open(candidate, 'r');
		const read = await readCodexRolloutRecords(handle.createReadStream(), deadline - Date.now());
		if ('reason' in read)
			return read.reason === 'malformed' ? invalid('malformed') : unavailable(read.reason);
		const after = await stat(candidate);
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs
		)
			return invalid('read_failed');
		return reconcileCodexRollout(read.records, input);
	} catch {
		return unavailable('read_failed');
	}
}
