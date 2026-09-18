import { readFileSync } from 'node:fs';

/**
 * Stdin, behind an interface so tests can supply a fake instead of
 * manipulating the real fd 0 (which vitest owns).
 */
export interface StdinSource {
	isTTY: boolean;
	/** Reads stdin to EOF. */
	read(): string;
}

const processStdin: StdinSource = {
	get isTTY() {
		return Boolean(process.stdin.isTTY);
	},
	read: () => readFileSync(0, 'utf8')
};

/** Shared option/argument help suffix for the commands that take a Markdown body. */
export const BODY_VALUE_HELP =
	'inline text, @file, or "-" to read stdin; escape a literal leading @ as @@';

/**
 * A Markdown body: inline text, `@file`, or `-` to read stdin to EOF (`@-`
 * is an alias). A literal leading `@` escapes as `@@`. Only *exactly* `-`
 * means stdin, so dated journal bullets ("- 2026-08-31: …") stay literal.
 *
 * Throws rather than calling die(): every caller sits inside an .action()
 * handler under the parseAsync try/catch, whose fallback prints
 * `error: <message>` and exits 1 — the same output die() produces.
 */
export function readBodyValue(value: string, stdin: StdinSource = processStdin): string {
	if (value.startsWith('@@')) return value.slice(1);
	if (value === '-' || value === '@-') {
		if (stdin.isTTY) {
			throw new Error(
				'"-" reads the body from stdin, but stdin is a terminal — pipe or redirect the Markdown (e.g. a quoted heredoc)'
			);
		}
		const raw = stdin.read();
		if (raw.trim() === '') throw new Error('no Markdown on stdin');
		return raw;
	}
	if (value.startsWith('@')) {
		const file = value.slice(1);
		try {
			return readFileSync(file, 'utf8');
		} catch (err) {
			throw new Error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return value;
}
