import type { AgentRunUsage } from '@tines/shared';
import { clip } from './claude-stream.js';
import {
	copySummary,
	validMetric,
	validProviderSessionId,
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

	constructor(private readonly emit: (line: string) => void) {}

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
		return copySummary(this.collected);
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

	private collect(event: JsonObject): void {
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
		let status: NonNullable<StreamSummary['pricingEvidence']>['measurement_status'] = complete
			? 'complete'
			: supplied < 4
				? 'missing'
				: 'invalid';
		if (
			complete &&
			previous &&
			['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'].some(
				(key) => (rawUsage as JsonObject)[key]! < (previous as JsonObject)[key]!
			)
		) {
			this.stickyStatus = 'nonmonotonic';
		}
		status = this.stickyStatus ?? status;
		const usage: AgentRunUsage = {};
		if (complete) usage.input_tokens = totalInput! - rawCached! - rawWrite!;
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
