import type { AgentRunUsage } from '@tines/shared';
import { clip } from './claude-stream.js';
import {
	copySummary,
	validMetric,
	validProviderSessionId,
	type HarnessOutcome,
	type RunStreamRenderer,
	type StreamSummary
} from './stream-summary.js';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The openings of the messages Codex 0.156.1 puts on a failed turn when the
 * provider refused or failed, copied from its stream. Either apostrophe:
 * September's Codex wrote `You've` (ASCII), 0.156.1 writes U+2019. The
 * usage-limit pattern stops before the period because Codex also writes
 * `You’ve hit your usage limit for <model>`.
 *
 * This is vendor text, not a contract: when it drifts we simply stop
 * recognising the message and fall back to a plain failure (a strike), never
 * to anything worse. Each is anchored at the start, because Codex embeds
 * provider response bodies in its other errors.
 */
const CODEX_USAGE_LIMIT = /^You['’]ve hit your usage limit/;
const CODEX_QUOTA_EXCEEDED = /^Quota exceeded\./;
const CODEX_PROVIDER_FAILURES = [
	/^Selected model is at capacity/,
	/^We['’]re currently experiencing high demand/
];

const CODEX_MONTHS = [
	'jan',
	'feb',
	'mar',
	'apr',
	'may',
	'jun',
	'jul',
	'aug',
	'sep',
	'oct',
	'nov',
	'dec'
];

/**
 * Codex prints the reset to the minute, so the window may reopen at any second
 * of it. Reporting the end of that minute keeps a run refused inside the
 * minute from naming a time already past, which the supervisor reads as "no
 * reset given" and holds its default instead.
 */
const CODEX_RESET_MINUTE_MS = 60_000;

/**
 * The reset time in `… try again at <time>.`, as epoch ms, or null when the
 * message names none we can read. Codex formats it in the machine's local
 * zone, as `Oct 7th, 2026 2:58 PM` or, for a reset later the same day,
 * `3:06 PM`; the daemon runs Codex on the same machine, so local time is read
 * back the same way.
 */
export function parseCodexResetTime(message: string, now: number): number | null {
	const stated = /\btry again at (.+?)\.?$/i.exec(message.trim())?.[1];
	if (!stated) return null;
	const parts =
		/^(?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) )?(\d{1,2}):(\d{2}) (AM|PM)$/.exec(
			stated
		);
	if (!parts) return null;
	const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = parts;
	const hour = Number(hourText);
	const minute = Number(minuteText);
	if (hour < 1 || hour > 12 || minute > 59) return null;
	const hour24 = (hour % 12) + (meridiem === 'PM' ? 12 : 0);
	if (monthName === undefined) {
		const today = new Date(now);
		return (
			new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour24, minute).getTime() +
			CODEX_RESET_MINUTE_MS
		);
	}
	const month = CODEX_MONTHS.indexOf(monthName.toLowerCase());
	if (month === -1) return null;
	const day = Number(dayText);
	const date = new Date(Number(yearText), month, day, hour24, minute);
	// `Feb 31st` rolls over into March rather than failing.
	if (date.getMonth() !== month || date.getDate() !== day) return null;
	return date.getTime() + CODEX_RESET_MINUTE_MS;
}

/**
 * A failed turn's message → the provider's refusal or failure it reports, or
 * undefined for anything else (a plain failure, as before).
 */
export function classifyCodexFailure(message: string, now: number): HarnessOutcome | undefined {
	const trimmed = message.trim();
	const detail = clip(trimmed, 500);
	if (CODEX_USAGE_LIMIT.test(trimmed)) {
		const resumeAt = parseCodexResetTime(trimmed, now);
		return { kind: 'rate_limited', detail, ...(resumeAt !== null ? { resumeAt } : {}) };
	}
	if (CODEX_QUOTA_EXCEEDED.test(trimmed)) return { kind: 'rate_limited', detail };
	if (CODEX_PROVIDER_FAILURES.some((pattern) => pattern.test(trimmed))) {
		return { kind: 'provider_error', detail };
	}
	return undefined;
}

export function renderCodexEvent(event: JsonObject): string[] {
	const type = event.type;
	if (type === 'thread.started') return ['[session] started'];
	if (type === 'turn.started') return ['[session] turn started'];
	if (type === 'turn.completed') return ['[session] turn completed'];
	if (type === 'turn.failed') {
		const error = object(event.error);
		return [`[error] ${clip(text(error?.message) ?? text(event.message) ?? 'turn failed', 2000)}`];
	}
	if (type === 'error') return [`[error] ${clip(text(event.message) ?? 'unknown error', 2000)}`];
	if (type !== 'item.completed') return [];
	const item = object(event.item);
	if (!item) return [];
	switch (item.type) {
		case 'agent_message':
			return text(item.text) ? [`[agent] ${clip(text(item.text)!, 2000)}`] : [];
		case 'command_execution': {
			const command = text(item.command) ?? 'command';
			const failed = validMetric(item.exit_code) && item.exit_code !== 0;
			const output = failed ? text(item.aggregated_output) : undefined;
			return [
				`[tool] ${clip(command, 300)}${failed ? ` (exit ${item.exit_code}${output ? `: ${clip(output, 300)}` : ''})` : ''}`
			];
		}
		case 'file_change': {
			const changes = Array.isArray(item.changes) ? item.changes : [];
			const paths = changes
				.map((change) => text(object(change)?.path))
				.filter((path): path is string => Boolean(path));
			return [`[tool] file change${paths.length ? `: ${clip(paths.join(', '), 300)}` : ''}`];
		}
		case 'mcp_tool_call':
			return [
				`[tool] ${clip([text(item.server), text(item.tool)].filter(Boolean).join('/') || 'MCP call', 300)}`
			];
		case 'web_search':
			return [`[tool] web search${text(item.query) ? `: ${clip(text(item.query)!, 300)}` : ''}`];
		default:
			return [];
	}
}

export class CodexStreamRenderer implements RunStreamRenderer {
	private pending = '';
	private collected: StreamSummary = {
		pricingEvidence: {
			version: 1,
			harness: 'codex',
			model: null,
			identity_source: 'launch_argument',
			usage_scope: 'thread_total',
			session_mode: 'cold',
			normalization: 'codex-jsonl-v1',
			model_rerouted: false,
			measurement_status: 'missing',
			terminal_snapshots: 0
		}
	};
	private finished = false;
	private threadId?: string;
	private stickyStatus?: 'nonmonotonic' | 'multiple_threads';
	private awaitingTerminal = false;
	/** How the current turn failed, when the provider refused or failed. */
	private turnOutcome?: HarnessOutcome;
	/** A top-level `error` that nothing has followed yet. */
	private trailingOutcome?: HarnessOutcome;

	constructor(
		private readonly emit: (line: string) => void,
		private readonly now: () => number = Date.now
	) {}

	write(chunk: string): void {
		this.pending += chunk;
		let nl = this.pending.indexOf('\n');
		while (nl !== -1) {
			this.line(this.pending.slice(0, nl));
			this.pending = this.pending.slice(nl + 1);
			nl = this.pending.indexOf('\n');
		}
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		if (this.pending) this.line(this.pending);
		this.pending = '';
	}

	summary(): StreamSummary {
		const outcome = this.turnOutcome ?? this.trailingOutcome;
		return copySummary({ ...this.collected, ...(outcome ? { harnessOutcome: outcome } : {}) });
	}

	private line(raw: string): void {
		const trimmed = raw.trim();
		if (!trimmed) return;
		let event: JsonObject;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			const parsedObject = object(parsed);
			if (!parsedObject) return;
			event = parsedObject;
		} catch {
			this.emit(`${raw}\n`);
			return;
		}
		this.collect(event);
		for (const line of renderCodexEvent(event)) this.emit(`${line}\n`);
	}

	/**
	 * Reads a refusal only from Codex's own `turn.failed` and `error` events,
	 * never from an item's content: an agent message or command output that
	 * quotes the usage-limit sentence must not hold the runner.
	 */
	private noteOutcome(event: JsonObject): void {
		switch (event.type) {
			case 'turn.started':
			case 'turn.completed':
				this.turnOutcome = undefined;
				this.trailingOutcome = undefined;
				return;
			case 'turn.failed':
				this.turnOutcome = classifyCodexFailure(
					text(object(event.error)?.message) ?? text(event.message) ?? '',
					this.now()
				);
				this.trailingOutcome = undefined;
				return;
			case 'error':
				this.trailingOutcome = classifyCodexFailure(text(event.message) ?? '', this.now());
				return;
			case 'item.started':
			case 'item.updated':
			case 'item.completed':
				// The stream carried on, so that error was not how the run ended.
				this.trailingOutcome = undefined;
				return;
		}
	}

	private collect(event: JsonObject): void {
		this.noteOutcome(event);
		if (event.type === 'thread.started' && validProviderSessionId(event.thread_id)) {
			if (this.threadId && this.threadId !== event.thread_id)
				this.stickyStatus = 'multiple_threads';
			this.threadId ??= event.thread_id;
			this.collected.providerSessionId ??= event.thread_id;
		}
		if (event.type === 'turn.started') {
			this.awaitingTerminal = true;
			this.updateEvidence('incomplete_attempt');
			return;
		}
		if (event.type === 'item.completed') {
			const item = object(event.item);
			if (item?.type === 'error' && /^model rerouted:/.test(text(item.message) ?? '')) {
				this.updateEvidence(undefined, true);
			}
			return;
		}
		if (event.type !== 'turn.completed') return;
		this.awaitingTerminal = false;
		const raw = object(event.usage);
		const previous = this.collected.pricingEvidence?.raw_usage;
		const metric = (value: unknown) =>
			Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
		const totalInput = metric(raw?.input_tokens);
		const rawCached = metric(raw?.cached_input_tokens);
		const rawWrite = metric(raw?.cache_write_input_tokens);
		const output = metric(raw?.output_tokens);
		const rawUsage = {
			...(totalInput !== undefined ? { input_tokens: totalInput } : {}),
			...(rawCached !== undefined ? { cached_input_tokens: rawCached } : {}),
			...(rawWrite !== undefined ? { cache_write_input_tokens: rawWrite } : {}),
			...(output !== undefined ? { output_tokens: output } : {})
		};
		const supplied = raw
			? ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'].filter(
					(key) => raw[key] !== undefined
				).length
			: 0;
		const complete =
			supplied === 4 && Object.keys(rawUsage).length === 4 && rawCached! + rawWrite! <= totalInput!;
		const previousInput = previous
			? metric(previous.input_tokens) !== undefined &&
				metric(previous.cached_input_tokens) !== undefined &&
				metric(previous.cache_write_input_tokens) !== undefined
				? previous.input_tokens! -
					previous.cached_input_tokens! -
					previous.cache_write_input_tokens!
				: undefined
			: undefined;
		const input = complete ? totalInput! - rawCached! - rawWrite! : undefined;
		let status: NonNullable<StreamSummary['pricingEvidence']>['measurement_status'] = complete
			? 'complete'
			: supplied < 4
				? 'missing'
				: 'invalid';
		if (
			(complete &&
				previous &&
				['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'].some(
					(key) => (rawUsage as JsonObject)[key]! < (previous as JsonObject)[key]!
				)) ||
			(input !== undefined && previousInput !== undefined && input < previousInput)
		) {
			this.stickyStatus = 'nonmonotonic';
		}
		status = this.stickyStatus ?? status;
		const usage: AgentRunUsage = {};
		if (complete) usage.input_tokens = input!;
		if (rawCached !== undefined) usage.cache_read_tokens = rawCached;
		if (rawWrite !== undefined) usage.cache_write_tokens = rawWrite;
		if (output !== undefined) usage.output_tokens = output;
		this.collected.usage = usage;
		this.updateEvidence(status, undefined, rawUsage);
	}

	private updateEvidence(
		status?: NonNullable<StreamSummary['pricingEvidence']>['measurement_status'],
		rerouted?: boolean,
		rawUsage?: NonNullable<StreamSummary['pricingEvidence']>['raw_usage']
	): void {
		const old = this.collected.pricingEvidence;
		this.collected.pricingEvidence = {
			version: 1,
			harness: 'codex',
			model: null,
			identity_source: 'launch_argument',
			usage_scope: 'thread_total',
			session_mode: 'cold',
			normalization: 'codex-jsonl-v1',
			...(rawUsage ? { raw_usage: rawUsage } : old?.raw_usage ? { raw_usage: old.raw_usage } : {}),
			model_rerouted: rerouted || old?.model_rerouted || false,
			measurement_status:
				this.stickyStatus ??
				status ??
				old?.measurement_status ??
				(this.awaitingTerminal ? 'incomplete_attempt' : 'missing'),
			terminal_snapshots: (old?.terminal_snapshots ?? 0) + (rawUsage ? 1 : 0)
		};
	}
}
