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
	private collected: StreamSummary = {};
	private finished = false;

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
		if (
			event.type === 'thread.started' &&
			!this.collected.providerSessionId &&
			validProviderSessionId(event.thread_id)
		) {
			this.collected.providerSessionId = event.thread_id;
		}
		if (event.type !== 'turn.completed') return;
		const raw = object(event.usage);
		if (!raw) return;
		const totalInput = validMetric(raw.input_tokens) ? raw.input_tokens : undefined;
		const rawCached = validMetric(raw.cached_input_tokens) ? raw.cached_input_tokens : undefined;
		const output = validMetric(raw.output_tokens) ? raw.output_tokens : undefined;
		if (totalInput === undefined && rawCached === undefined && output === undefined) return;
		const usage: AgentRunUsage = {};
		if (totalInput !== undefined) {
			const cached = rawCached === undefined ? undefined : Math.min(rawCached, totalInput);
			usage.input_tokens = totalInput - (cached ?? 0);
			if (cached !== undefined) usage.cache_read_tokens = cached;
		} else if (rawCached !== undefined) usage.cache_read_tokens = rawCached;
		if (output !== undefined) usage.output_tokens = output;
		this.collected.usage = usage;
	}
}
