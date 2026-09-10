import { LibraryValidationError, type PackageInput } from './types.js';

export function inputToken(key: string, defaultValue: string | null): string {
	const escaped = (defaultValue ?? '')
		.replaceAll('\\', '\\\\')
		.replaceAll(':', '\\:')
		.replaceAll('}', '\\}');
	return `{{${key}:${escaped}}}`;
}

export function renderDeclaredToken(
	source: string,
	token: string,
	value: string
): { value: string; count: number } {
	let rendered = '';
	let count = 0;
	for (let offset = 0; offset < source.length;) {
		const found = source.indexOf(token, offset);
		if (found < 0) {
			rendered += source.slice(offset).replaceAll(`\\${token}`, token);
			break;
		}
		if (found > 0 && source[found - 1] === '\\') {
			rendered += source.slice(offset, found - 1) + token;
			offset = found + token.length;
			continue;
		}
		rendered += source.slice(offset, found) + value;
		count++;
		offset = found + token.length;
	}
	return { value: rendered, count };
}

export function validateInput(input: PackageInput): void {
	if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.key)) {
		throw new LibraryValidationError([
			{
				path: '/inputs',
				code: 'invalid_input_key',
				message: `Invalid input key ${JSON.stringify(input.key)}`
			}
		]);
	}
	if (input.default !== null && input.default.length > 10_000) {
		throw new LibraryValidationError([
			{
				path: '/inputs',
				code: 'input_too_long',
				message: `Input ${input.key} exceeds 10000 characters`
			}
		]);
	}
}
