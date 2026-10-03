/**
 * Renders Pi's `--mode json` JSONL event stream into the same readable log
 * lines the other harnesses produce (Tines/900), and collects what the
 * daemon needs from it: the session id, token usage, the thinking level Pi
 * actually applied, and — because `pi` exits 0 when the model call failed —
 * its own account of how the run ended.
 *
 * Shapes are those `pi` 0.99.2 emits. Lines are split on LF only: Pi's docs
 * warn that a U+2028 or U+2029 inside a string is not a line boundary, which
 * is what a `readline`-style splitter gets wrong.
 *
 * Anything that is not a JSON object passes through verbatim, as in
 * claude-stream.ts, so a `pi` that ignores the flag still leaves a log.
 */
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

interface PiContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
}

interface PiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

interface PiMessage {
	role?: string;
	content?: string | PiContentBlock[];
	/** The system message carries its prompt here, not in `content`. */
	sections?: Record<string, unknown>;
	toolsAdded?: unknown;
	provider?: string;
	model?: string;
	usage?: PiUsage;
	stopReason?: string;
	errorMessage?: string;
	thinkingLevel?: string;
}

export interface PiStreamEvent {
	type?: string;
	/** `session`: the id `--session <id>` reopens. */
	id?: string;
	message?: PiMessage;
	toolName?: string;
	args?: unknown;
	result?: {
		content?: PiContentBlock[];
		structuredContent?: { output?: string; exit_code?: number };
	};
	isError?: boolean;
	attempt?: number;
	maxAttempts?: number;
	errorMessage?: string;
	success?: boolean;
	finalError?: string;
}

function blocks(content: PiMessage['content']): PiContentBlock[] {
	return Array.isArray(content) ? content : [];
}

function blockText(content: PiContentBlock[] | undefined): string {
	return (content ?? [])
		.map((block) => (typeof block?.text === 'string' ? block.text : ''))
		.join('')
		.trim();
}

/** A stop reason that means the model call itself did not produce an answer. */
function failedStop(message: PiMessage): boolean {
	return message.stopReason === 'error' || message.stopReason === 'aborted';
}

/** `[tool] bash: <command>`, or the tool with the path it touches (else its args). */
function toolLine(event: PiStreamEvent): string {
	const name = event.toolName ?? 'tool';
	const args =
		event.args && typeof event.args === 'object' ? (event.args as Record<string, unknown>) : {};
	if (name === 'bash' && typeof args.command === 'string') {
		return `[tool] bash: ${clip(args.command, 300)}`;
	}
	if (typeof args.path === 'string') return `[tool] ${name} ${clip(args.path, 300)}`;
	const rest = event.args === undefined ? '' : JSON.stringify(event.args);
	return `[tool] ${name} ${clip(rest, 300)}`.trimEnd();
}

/**
 * One stream event → zero or more log lines. Per-token `message_update`s,
 * `message_start`, tool progress, the turn and agent markers, and the system
 * and user messages render nothing: the prompt is already in the run record,
 * and the rest repeats what `message_end` says once.
 */
export function renderPiEvent(event: PiStreamEvent): string[] {
	switch (event.type) {
		case 'session':
			return ['[session] started'];
		case 'message_end': {
			if (event.message?.role !== 'assistant') return [];
			const lines: string[] = [];
			for (const block of blocks(event.message.content)) {
				if (block.type === 'text' && block.text?.trim()) {
					lines.push(`[agent] ${clip(block.text.trim(), 2000)}`);
				}
			}
			return lines;
		}
		case 'tool_execution_start':
			return [toolLine(event)];
		case 'tool_execution_end': {
			// As for the other harnesses, only a failed tool earns a line.
			const exitCode = event.result?.structuredContent?.exit_code;
			if (!event.isError && !(typeof exitCode === 'number' && exitCode !== 0)) return [];
			const output =
				blockText(event.result?.content) || (event.result?.structuredContent?.output ?? '').trim();
			return [`[tool] ${event.toolName ?? 'tool'} failed: ${clip(output, 300)}`];
		}
		case 'auto_retry_start':
			return [
				`[retry] attempt ${event.attempt ?? '?'}/${event.maxAttempts ?? '?'}: ${clip(event.errorMessage ?? '', 300)}`
			];
		case 'auto_retry_end':
			if (event.success !== false) return [];
			return [`[error] ${clip(event.finalError ?? 'retries exhausted', 2000)}`];
		default:
			return [];
	}
}

/** Characters a message adds to the conversation, for the no-usage estimate. */
function messageChars(message: PiMessage): number {
	let chars = typeof message.content === 'string' ? message.content.length : 0;
	for (const block of blocks(message.content)) {
		if (typeof block.text === 'string') chars += block.text.length;
		if (typeof block.thinking === 'string') chars += block.thinking.length;
		if (block.type === 'toolCall') {
			chars += (block.name ?? '').length + JSON.stringify(block.arguments ?? {}).length;
		}
	}
	for (const section of Object.values(message.sections ?? {})) {
		if (typeof section === 'string') chars += section.length;
	}
	if (message.toolsAdded !== undefined) chars += JSON.stringify(message.toolsAdded).length;
	return chars;
}

/** How the last failed model call is classified, from the provider's own words. */
function classifyFailure(detail: string): HarnessOutcome {
	if (/^429\b/.test(detail)) return { kind: 'rate_limited', detail };
	if (/^5\d\d\b/.test(detail) || /Connection error|fetch failed|ECONNREFUSED/.test(detail)) {
		return { kind: 'provider_error', detail };
	}
	return { kind: 'error', detail };
}

export interface PiStreamOptions {
	/**
	 * Called once, with the thinking level the first successful assistant
	 * message records — the proof of the effort Pi applied, which it clamps to
	 * the model's capabilities without saying so.
	 */
	onAppliedEffort?: (level: string) => void;
	/** This run reopened an earlier session: the estimate cannot see its history. */
	resumed?: boolean;
}

/**
 * Feeds raw stdout chunks in, gets rendered lines out. Partial lines are held
 * until their newline arrives; `finish()` flushes whatever is left.
 */
export class PiStreamRenderer implements RunStreamRenderer {
	private pending = '';
	private finished = false;
	private providerSessionId: string | undefined;
	private numTurns = 0;
	private readonly tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	private cost = 0;
	/** Assistant messages that ended, and those of them that were real answers. */
	private assistantMessages = 0;
	private answered = 0;
	private lastAssistant: PiMessage | null = null;
	private lastRetryFailure: string | null = null;
	private appliedEffort: string | undefined;
	/** The estimate's running totals, in characters. */
	private contextChars = 0;
	private estimatedInputChars = 0;
	private estimatedOutputChars = 0;

	constructor(
		private readonly emit: (line: string) => void,
		private readonly opts: PiStreamOptions = {}
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

	/**
	 * Renders any trailing partial line, then — when the model server reported
	 * no usage at all — the labelled estimate. Call once the harness has exited.
	 */
	finish(): void {
		if (this.finished) return;
		this.finished = true;
		if (this.pending) {
			this.line(this.pending);
			this.pending = '';
		}
		// Only for a run the model actually answered: a failed call reports no
		// usage because there was none, not because the server keeps it back.
		if (this.answered > 0 && !this.measured()) {
			this.emit(
				`[usage] the model server reported no token usage; rough estimate ~${Math.round(this.estimatedInputChars / 4)} input / ~${Math.round(this.estimatedOutputChars / 4)} output tokens (characters ÷ 4, not recorded)${this.opts.resumed ? "; this run's messages only" : ''}\n`
			);
		}
	}

	summary(): StreamSummary {
		const usage = this.usage();
		return copySummary({
			...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
			...(usage ? { usage } : {}),
			...(this.numTurns > 0 ? { numTurns: this.numTurns } : {}),
			harnessOutcome: this.outcome(),
			...(this.appliedEffort ? { appliedEffort: this.appliedEffort } : {})
		});
	}

	private measured(): boolean {
		return this.cost > 0 || Object.values(this.tokens).some((value) => value > 0);
	}

	/**
	 * Nothing when every sum is zero: a local model server that reports no
	 * usage must not be recorded as a run that used zero tokens. Tokens alone
	 * carry no `cost_source` — `none` beside tokens reads as inconsistent to
	 * usage accounting — and Pi's own cost is passed on only when it has one.
	 */
	private usage(): AgentRunUsage | undefined {
		if (!this.measured()) return undefined;
		return {
			input_tokens: this.tokens.input,
			output_tokens: this.tokens.output,
			cache_read_tokens: this.tokens.cacheRead,
			cache_write_tokens: this.tokens.cacheWrite,
			...(this.cost > 0 ? { cost_usd: this.cost, cost_source: 'provider' as const } : {})
		};
	}

	private outcome(): HarnessOutcome {
		const last = this.lastAssistant;
		if (!last) return { kind: 'error', detail: 'pi ended without an assistant message' };
		if (!failedStop(last)) return { kind: 'ok' };
		return classifyFailure(last.errorMessage || this.lastRetryFailure || last.stopReason!);
	}

	private line(raw: string): void {
		const trimmed = raw.trim();
		if (!trimmed) return;
		if (!trimmed.startsWith('{')) {
			// Not the JSON stream: pass it through so the log is never empty.
			this.emit(`${raw}\n`);
			return;
		}
		let event: PiStreamEvent;
		try {
			event = JSON.parse(trimmed) as PiStreamEvent;
		} catch {
			this.emit(`${raw}\n`);
			return;
		}
		if (!event || typeof event !== 'object' || Array.isArray(event)) return;
		for (const line of this.collect(event)) this.emit(`${line}\n`);
		for (const line of renderPiEvent(event)) this.emit(`${line}\n`);
	}

	/** Updates the summary; returns the lines only the renderer's state can write. */
	private collect(event: PiStreamEvent): string[] {
		switch (event.type) {
			case 'session':
				if (!this.providerSessionId && validProviderSessionId(event.id)) {
					this.providerSessionId = event.id;
				}
				return [];
			case 'turn_end':
				this.numTurns++;
				return [];
			case 'auto_retry_end':
				if (event.success === false) this.lastRetryFailure = event.finalError ?? null;
				return [];
			case 'message_end':
				return event.message && typeof event.message === 'object'
					? this.collectMessage(event.message)
					: [];
			default:
				return [];
		}
	}

	private collectMessage(message: PiMessage): string[] {
		const chars = messageChars(message);
		if (message.role !== 'assistant') {
			// A tool can run a model of its own; its usage is this run's too.
			if (message.role === 'toolResult') this.addUsage(message.usage);
			this.contextChars += chars;
			return [];
		}
		const lines: string[] = [];
		if (this.assistantMessages++ === 0 && message.model) {
			const model = message.provider ? `${message.provider}/${message.model}` : message.model;
			lines.push(
				`[session] model ${model}${message.thinkingLevel ? ` thinking=${message.thinkingLevel}` : ''}`
			);
		}
		this.lastAssistant = message;
		this.addUsage(message.usage);
		if (failedStop(message)) return lines;
		this.answered++;
		// Each request re-sends the conversation so far, so the input side grows
		// with every assistant message rather than once.
		this.estimatedInputChars += this.contextChars;
		this.estimatedOutputChars += chars;
		this.contextChars += chars;
		if (this.appliedEffort === undefined && typeof message.thinkingLevel === 'string') {
			this.appliedEffort = message.thinkingLevel;
			this.opts.onAppliedEffort?.(message.thinkingLevel);
		}
		return lines;
	}

	private addUsage(usage: PiUsage | undefined): void {
		if (!usage || typeof usage !== 'object') return;
		for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
			const value = usage[key];
			if (validMetric(value)) this.tokens[key] += value;
		}
		const cost = usage.cost?.total;
		if (validMetric(cost)) this.cost += cost;
	}
}
