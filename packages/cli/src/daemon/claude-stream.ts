/**
 * Renders Claude Code's `--output-format stream-json` NDJSON into the same
 * human-readable log lines managed runs already produce (Tines/66).
 *
 * Why here and not in the UI: every surface — the D1 tail, the full log in
 * R2, `tines runs show --logs`, the web viewer — then reads prose, and none
 * of them needs to know the harness's wire format. The unrendered stream is
 * not thrown away; the daemon spools it and uploads it as the run's raw log.
 *
 * The grammar deliberately mirrors `apps/web/src/lib/server/supervisor/
 * claude-events.ts` (`[agent]`, `[tool]`, `[session]`, `[error]`), so a
 * local run's log reads like a managed one. The two renderers stay separate:
 * they consume different wire formats and live in different packages.
 *
 * Anything that is not a JSON object passes through verbatim, so an older
 * `claude` that ignores the flag — or any other process writing prose to
 * stdout — still produces a usable log instead of nothing.
 */

/** Matches claude-events.ts: long values are clipped, not dropped. */
export function clip(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
	input?: unknown;
	content?: unknown;
	is_error?: boolean;
}

interface StreamEvent {
	type?: string;
	subtype?: string;
	model?: string;
	message?: { content?: ContentBlock[] };
	num_turns?: number;
	total_cost_usd?: number;
	is_error?: boolean;
	result?: string;
}

/** Tool results arrive as a string or as content blocks; both flatten to text. */
function resultText(content: unknown): string {
	if (typeof content === 'string') return content.trim();
	if (Array.isArray(content)) {
		return content
			.map((block: ContentBlock) => (typeof block?.text === 'string' ? block.text : ''))
			.join('')
			.trim();
	}
	return '';
}

/**
 * One stream event → zero or more log lines.
 *
 * Thinking blocks, `system/thinking_tokens`, and `rate_limit_event` are
 * dropped: measured at ~18% of the stream's bytes, and nothing a human
 * reading a run's log is looking for. They survive in the raw upload.
 */
export function renderStreamEvent(event: StreamEvent): string[] {
	switch (event.type) {
		case 'system':
			if (event.subtype === 'init') {
				return [`[session] started${event.model ? ` (model ${event.model})` : ''}`];
			}
			return [];
		case 'assistant': {
			const lines: string[] = [];
			for (const block of event.message?.content ?? []) {
				if (block.type === 'text' && block.text?.trim()) {
					lines.push(`[agent] ${clip(block.text.trim(), 2000)}`);
				} else if (block.type === 'tool_use') {
					// The tool's input is what makes this log worth reading: it
					// is the shell command, the file path, the search pattern.
					const args = block.input === undefined ? '' : JSON.stringify(block.input);
					lines.push(`[tool] ${block.name ?? 'tool'} ${clip(args, 300)}`.trimEnd());
				}
			}
			return lines;
		}
		case 'user': {
			// Tool results are voluminous and mostly uninteresting; only the
			// failures earn a line, matching the managed-run renderer.
			const lines: string[] = [];
			for (const block of event.message?.content ?? []) {
				if (block.type === 'tool_result' && block.is_error) {
					lines.push(`[tool] error: ${clip(resultText(block.content), 300)}`);
				}
			}
			return lines;
		}
		case 'result': {
			const parts: string[] = [];
			if (typeof event.num_turns === 'number') parts.push(`${event.num_turns} turns`);
			if (typeof event.total_cost_usd === 'number')
				parts.push(`$${event.total_cost_usd.toFixed(2)}`);
			const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
			const lines = [`[session] result: ${event.subtype ?? 'done'}${detail}`];
			// An error result carries the reason in `result`; it is the single
			// most useful line in a failed run's log.
			if (event.is_error && event.result) lines.push(`[error] ${clip(event.result, 2000)}`);
			return lines;
		}
		default:
			return [];
	}
}

/**
 * Feeds raw stdout chunks in, gets rendered lines out.
 *
 * Chunk boundaries fall wherever the pipe decides, so partial lines are held
 * until their newline arrives; `finish()` flushes whatever is left when the
 * process exits without a trailing newline.
 */
export class ClaudeStreamRenderer {
	private pending = '';

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

	/** Renders any trailing partial line. Call once the harness has exited. */
	finish(): void {
		if (this.pending) {
			this.line(this.pending);
			this.pending = '';
		}
	}

	private line(raw: string): void {
		const trimmed = raw.trim();
		if (!trimmed) return;
		if (!trimmed.startsWith('{')) {
			// Not stream-json: pass it through so the log is never empty.
			this.emit(`${raw}\n`);
			return;
		}
		let event: StreamEvent;
		try {
			event = JSON.parse(trimmed) as StreamEvent;
		} catch {
			this.emit(`${raw}\n`);
			return;
		}
		for (const line of renderStreamEvent(event)) this.emit(`${line}\n`);
	}
}
