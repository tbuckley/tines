/**
 * Pure helpers for the Claude adapter's poll loop: provider session events →
 * run-log lines, provider usage → `AgentRunUsage`. No I/O and nothing bound to
 * `env` or the SDK client, so they are unit-tested directly in
 * `claude-events.test.ts` instead of through the adapter's network fake.
 */
import type { BetaManagedAgentsSessionUsage } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
import type { BetaManagedAgentsSessionEvent } from '@anthropic-ai/sdk/resources/beta/sessions/events';
import type { AgentRunUsage } from '@tines/shared';

export function mapUsage(usage: BetaManagedAgentsSessionUsage | undefined): AgentRunUsage {
	const cacheWrite =
		(usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
		(usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0);
	const out: AgentRunUsage = {
		input_tokens: usage?.input_tokens ?? 0,
		output_tokens: usage?.output_tokens ?? 0,
		cost_source: 'provider'
	};
	if (usage?.cache_read_input_tokens) out.cache_read_tokens = usage.cache_read_input_tokens;
	if (cacheWrite) out.cache_write_tokens = cacheWrite;
	// list_cost is cents as an integer string; the ledger stores dollars.
	if (usage?.list_cost?.amount) out.cost_usd = Number(usage.list_cost.amount) / 100;
	return out;
}

export function textOf(content: Array<{ type: string; text?: string }> | undefined): string {
	return (content ?? [])
		.map((block) => ('text' in block && block.text ? block.text : ''))
		.join('')
		.trim();
}

export function clip(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** One session event → zero or one log lines (the sweep-rendered summary). */
export function renderEvent(event: BetaManagedAgentsSessionEvent): string | null {
	switch (event.type) {
		case 'user.message':
			return `[user] message delivered (${textOf(event.content as never).length} chars)`;
		case 'agent.message': {
			const text = textOf(event.content as never);
			return text ? `[agent] ${clip(text, 2000)}` : null;
		}
		case 'agent.tool_use':
		case 'agent.mcp_tool_use': {
			const name = 'name' in event ? (event as { name: string }).name : 'tool';
			const args = 'input' in event ? JSON.stringify((event as { input: unknown }).input) : '';
			return `[tool] ${name} ${clip(args, 300)}`;
		}
		case 'agent.tool_result':
		case 'agent.mcp_tool_result': {
			if (!('is_error' in event) || !event.is_error) return null;
			return `[tool] error: ${clip(textOf(event.content as never), 300)}`;
		}
		case 'session.error': {
			const err = event.error as { message?: string } | undefined;
			return `[error] ${err?.message ?? 'unknown session error'}`;
		}
		case 'session.status_running':
			return '[session] running';
		case 'session.status_idle':
			return `[session] idle (${event.stop_reason?.type ?? 'unknown'})`;
		case 'session.status_terminated':
			return '[session] terminated';
		case 'agent.thread_context_compacted':
			return '[session] context compacted';
		default:
			return null;
	}
}

/** What one page of session events contributes to the run: log lines, a new
 *  cursor, and the two session-level facts `poll` decides the outcome from. */
export interface EventSummary {
	lines: string[];
	/** `processed_at` of the newest event seen, or `cursor` when none carried one. */
	cursor?: string;
	idleReason?: string;
	lastError?: string;
}

/** Folds a page of session events (oldest first) into the poll loop's summary. */
export function summarizeEvents(
	events: BetaManagedAgentsSessionEvent[],
	cursor?: string
): EventSummary {
	const lines: string[] = [];
	let idleReason: string | undefined;
	let lastError: string | undefined;
	for (const event of events) {
		const line = renderEvent(event);
		if (line) lines.push(line);
		if ('processed_at' in event && event.processed_at) cursor = event.processed_at;
		if (event.type === 'session.status_idle') idleReason = event.stop_reason?.type;
		if (event.type === 'session.error') {
			lastError = (event.error as { message?: string } | undefined)?.message ?? 'session error';
		}
	}
	return { lines, cursor, idleReason, lastError };
}
