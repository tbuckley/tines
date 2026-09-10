import { LibraryValidationError, type PackageInput } from './types.js';

export function inputToken(key: string, defaultValue: string | null): string {
	const escaped = (defaultValue ?? '')
		.replaceAll('\\', '\\\\')
		.replaceAll(':', '\\:')
		.replaceAll('}', '\\}');
	return `{{${key}:${escaped}}}`;
}

/** Matches the original field once. Inserted values never become match candidates. */
export function renderDeclaredTokens(
	source: string,
	declarations: readonly { token: string; value: string }[]
): { value: string; counts: number[] } {
	const tokens = new Set<string>();
	for (const { token } of declarations) {
		if (!token || tokens.has(token))
			throw new LibraryValidationError([
				{
					path: '/text_uses',
					code: 'duplicate_text_use',
					message: 'Tokens must be non-empty and unique within a field'
				}
			]);
		tokens.add(token);
	}
	const matches: { start: number; end: number; index: number; escaped: boolean }[] = [];
	declarations.forEach(({ token }, index) => {
		for (let offset = 0; offset < source.length;) {
			const start = source.indexOf(token, offset);
			if (start < 0) break;
			matches.push({
				start,
				end: start + token.length,
				index,
				escaped: start > 0 && source[start - 1] === '\\'
			});
			// Find overlaps too: accepting them would make rendering order-dependent.
			offset = start + 1;
		}
	});
	matches.sort((a, b) => a.start - b.start || a.end - b.end);
	for (let i = 1; i < matches.length; i++) {
		if (matches[i].start < matches[i - 1].end)
			throw new LibraryValidationError([
				{
					path: '/text_uses',
					code: 'overlapping_text_use',
					message: 'Declared token occurrences overlap'
				}
			]);
	}
	let value = '';
	let offset = 0;
	const counts = declarations.map(() => 0);
	for (const match of matches) {
		value += source.slice(offset, match.escaped ? match.start - 1 : match.start);
		value += match.escaped ? declarations[match.index].token : declarations[match.index].value;
		if (!match.escaped) counts[match.index]++;
		offset = match.end;
	}
	return { value: value + source.slice(offset), counts };
}

export function renderDeclaredToken(
	source: string,
	token: string,
	value: string
): { value: string; count: number } {
	const rendered = renderDeclaredTokens(source, [{ token, value }]);
	return { value: rendered.value, count: rendered.counts[0] };
}

export function validateInput(input: PackageInput): void {
	if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.key))
		throw new LibraryValidationError([
			{
				path: '/inputs',
				code: 'invalid_input_key',
				message: `Invalid input key ${JSON.stringify(input.key)}`
			}
		]);
	if (input.default !== null && input.default.length > 10000)
		throw new LibraryValidationError([
			{
				path: '/inputs',
				code: 'input_too_long',
				message: `Input ${input.key} exceeds 10000 characters`
			}
		]);
}
