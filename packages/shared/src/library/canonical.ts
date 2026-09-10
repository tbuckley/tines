import { LIBRARY_MAX_BYTES } from '../types.js';
import { validateUnicode, invalid, pointer } from './schema.js';
import { validateLibraryV3References } from './references.js';
import { LibraryValidationError, type PortableLibraryV3Document } from './types.js';

function canonicalValue(value: unknown, path = '', depth = 0): string {
	if (depth > 64) invalid(path, 'maximum_depth', 'JSON nesting exceeds 64');
	if (typeof value === 'string') validateUnicode(value, path);
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value))
			throw new LibraryValidationError([
				{ path: '', code: 'invalid_number', message: 'Numbers must be finite' }
			]);
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++)
			if (!Object.hasOwn(value, i))
				invalid(pointer(path, i), 'invalid_value', 'Sparse arrays are not JSON values');
		return `[${value.map((v, i) => canonicalValue(v, pointer(path, i), depth + 1)).join(',')}]`;
	}
	if (typeof value === 'object') {
		if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
			invalid(path, 'invalid_value', 'Expected a plain JSON object');
		for (const key of Object.keys(value as object)) validateUnicode(key, pointer(path, key));
		return `{${Object.keys(value as object)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalValue((value as Record<string, unknown>)[key], pointer(path, key), depth + 1)}`
			)
			.join(',')}}`;
	}
	throw new LibraryValidationError([
		{
			path: '',
			code: 'invalid_value',
			message: 'Undefined and non-JSON values are not canonicalizable'
		}
	]);
}

export function canonicalizeLibraryValue(value: unknown): string {
	return canonicalValue(value);
}

export async function libraryDocumentDigest(
	document: Omit<PortableLibraryV3Document, 'digest'> | PortableLibraryV3Document
): Promise<string> {
	const { digest: _digest, ...unsigned } = document as PortableLibraryV3Document;
	validateLibraryV3References(unsigned as PortableLibraryV3Document);
	const bytes = new TextEncoder().encode(canonicalValue(unsigned));
	if (
		new TextEncoder().encode(canonicalValue({ ...unsigned, digest: `sha256:${'0'.repeat(64)}` }))
			.byteLength > LIBRARY_MAX_BYTES
	)
		invalid('', 'package_too_large', `Document exceeds ${LIBRARY_MAX_BYTES} bytes`);
	const hash = await crypto.subtle.digest('SHA-256', bytes);
	return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function withLibraryDocumentDigest<T extends PortableLibraryV3Document>(
	document: T
): Promise<T> {
	return { ...document, digest: await libraryDocumentDigest(document) };
}
