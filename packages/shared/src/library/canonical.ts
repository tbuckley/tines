import { LibraryValidationError, type PortableLibraryV3Document } from './types.js';

function canonicalValue(value: unknown): string {
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
	if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
	if (typeof value === 'object') {
		return `{${Object.keys(value as object)
			.sort()
			.map(
				(key) => `${JSON.stringify(key)}:${canonicalValue((value as Record<string, unknown>)[key])}`
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
	const bytes = new TextEncoder().encode(canonicalValue(unsigned));
	const hash = await crypto.subtle.digest('SHA-256', bytes);
	return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function withLibraryDocumentDigest<T extends PortableLibraryV3Document>(
	document: T
): Promise<T> {
	return { ...document, digest: await libraryDocumentDigest(document) };
}
