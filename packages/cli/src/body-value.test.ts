import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readBodyValue, type StdinSource } from './body-value.js';

const dir = mkdtempSync(join(tmpdir(), 'body-value-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function tempFile(name: string, content: string): string {
	const path = join(dir, name);
	writeFileSync(path, content, 'utf8');
	return path;
}

/** A stdin that fails the test if it is read when it should not be. */
function fakeStdin(content: string, isTTY = false): StdinSource {
	return { isTTY, read: () => content };
}

const neverRead: StdinSource = {
	isTTY: false,
	read: () => {
		throw new Error('stdin should not have been read');
	}
};

describe('readBodyValue', () => {
	it('returns inline text verbatim', () => {
		expect(readBodyValue('hello', neverRead)).toBe('hello');
	});

	it('leaves shell-flavoured inline text untouched', () => {
		const body = 'see `$TINES_API_KEY` and "quotes" and \\backslash\\';
		expect(readBodyValue(body, neverRead)).toBe(body);
	});

	it('treats a dated journal bullet as literal text, not stdin', () => {
		expect(readBodyValue('- 2026-08-31: a lesson', neverRead)).toBe('- 2026-08-31: a lesson');
	});

	it('treats a lone dash-prefixed word as literal text', () => {
		expect(readBodyValue('-x', neverRead)).toBe('-x');
	});

	it('reads @file', () => {
		const path = tempFile('body.md', '# Heading\n\nBody with `backticks`.\n');
		expect(readBodyValue(`@${path}`, neverRead)).toBe('# Heading\n\nBody with `backticks`.\n');
	});

	it('preserves the exact bytes of a file, including a trailing newline', () => {
		const path = tempFile('exact.md', 'line\n\n\n');
		expect(readBodyValue(`@${path}`, neverRead)).toBe('line\n\n\n');
	});

	it('passes an empty file through unchanged', () => {
		const path = tempFile('empty.md', '');
		expect(readBodyValue(`@${path}`, neverRead)).toBe('');
	});

	it('throws a clear error for a missing file, without reading stdin', () => {
		const path = join(dir, 'does-not-exist.md');
		expect(() => readBodyValue(`@${path}`, neverRead)).toThrow(`cannot read ${path}`);
	});

	it('unescapes @@ to a literal leading @', () => {
		expect(readBodyValue('@@mention: see above', neverRead)).toBe('@mention: see above');
	});

	it('unescapes @@- to a literal @-', () => {
		expect(readBodyValue('@@-', neverRead)).toBe('@-');
	});

	it('reads stdin for "-"', () => {
		expect(readBodyValue('-', fakeStdin('from stdin\n'))).toBe('from stdin\n');
	});

	it('reads stdin for "@-"', () => {
		expect(readBodyValue('@-', fakeStdin('from stdin\n'))).toBe('from stdin\n');
	});

	it('does not try to open a file named "-" for the @- alias', () => {
		// A file-open attempt would throw "cannot read -" instead.
		expect(readBodyValue('@-', fakeStdin('stdin won'))).toBe('stdin won');
	});

	it('throws instead of hanging when "-" is used on a terminal', () => {
		expect(() => readBodyValue('-', fakeStdin('', true))).toThrow('stdin is a terminal');
	});

	it('throws on empty stdin', () => {
		expect(() => readBodyValue('-', fakeStdin('   \n'))).toThrow('no Markdown on stdin');
	});
});
