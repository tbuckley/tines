/**
 * Pure daemon logic — harness invocation building, command-template
 * expansion, and log-chunk batching — kept free of I/O so it is
 * unit-testable without a daemon (see support.test.ts). The loop itself
 * lives in daemon.ts.
 */

export type HarnessKind = 'claude_code' | 'codex' | 'custom';

export const HARNESS_KINDS: readonly HarnessKind[] = ['claude_code', 'codex', 'custom'];

/** POSIX single-quote escaping: safe interpolation into an `sh -c` string. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface HarnessInput {
	workspace: string;
	promptFile: string;
	/** The full prompt text (preamble + context + issue block). */
	prompt: string;
	/** Resolved model, or null when the harness cannot vary it. */
	model: string | null;
}

/**
 * Expands a custom command template: `{prompt_file}`, `{workspace}`, and
 * `{model}` are substituted shell-quoted (an absent model becomes `''`), so
 * paths with spaces survive the `sh -c` round trip.
 */
export function expandCommandTemplate(template: string, input: HarnessInput): string {
	return template
		.replaceAll('{prompt_file}', shellQuote(input.promptFile))
		.replaceAll('{workspace}', shellQuote(input.workspace))
		.replaceAll('{model}', input.model ? shellQuote(input.model) : "''");
}

export interface HarnessInvocation {
	file: string;
	args: string[];
}

/**
 * The argv to launch a harness with (cwd = the workspace). The built-in
 * harnesses get the prompt as an argument — the `claude -p "$(cat
 * prompt.md)"` pattern without the shell round trip — and the model via
 * their model flag; a custom template runs under `sh -c` with the
 * placeholders expanded.
 */
export function buildHarnessInvocation(
	spec: { harness: HarnessKind; command?: string },
	input: HarnessInput
): HarnessInvocation {
	switch (spec.harness) {
		case 'claude_code':
			return {
				file: 'claude',
				args: ['-p', input.prompt, ...(input.model ? ['--model', input.model] : [])]
			};
		case 'codex':
			return {
				file: 'codex',
				args: ['exec', ...(input.model ? ['--model', input.model] : []), input.prompt]
			};
		case 'custom': {
			if (!spec.command) throw new Error('the custom harness needs a --command template');
			return { file: 'sh', args: ['-c', expandCommandTemplate(spec.command, input)] };
		}
	}
}

export interface LogBatcherOptions {
	/** Flush as soon as the buffer reaches this many bytes. Default 8 KB. */
	maxBytes?: number;
	/** Flush at most this long after the first unflushed byte. Default 2 s. */
	intervalMs?: number;
	/** Send failures land here (default: swallowed) — the tail is best-effort. */
	onError?: (err: unknown) => void;
}

/**
 * Batches harness output into log-append chunks: a chunk is sent when the
 * buffer reaches `maxBytes`, or `intervalMs` after output first arrived —
 * so a chatty harness doesn't produce a request per line and a quiet one
 * still streams promptly. Sends are serialized (chunks arrive in order).
 */
export class LogBatcher {
	private buffer = '';
	private timer: ReturnType<typeof setTimeout> | null = null;
	private sending: Promise<void> = Promise.resolve();

	constructor(
		private readonly send: (chunk: string) => Promise<void>,
		private readonly opts: LogBatcherOptions = {}
	) {}

	append(text: string): void {
		if (!text) return;
		this.buffer += text;
		if (Buffer.byteLength(this.buffer, 'utf8') >= (this.opts.maxBytes ?? 8 * 1024)) {
			void this.flush();
		} else if (!this.timer) {
			this.timer = setTimeout(() => void this.flush(), this.opts.intervalMs ?? 2000);
			this.timer.unref?.();
		}
	}

	/** Sends whatever is buffered now; resolves when every send so far settled. */
	flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const chunk = this.buffer;
		this.buffer = '';
		if (chunk) {
			this.sending = this.sending
				.then(() => this.send(chunk))
				.catch((err) => this.opts.onError?.(err));
		}
		return this.sending;
	}
}
