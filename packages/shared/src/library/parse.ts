import { LIBRARY_MAX_BYTES } from '../types.js';
import { libraryDocumentDigest } from './canonical.js';
import { validateLibraryV3References } from './references.js';
import {
	LIBRARY_V3_MAX_DEPTH,
	LibraryValidationError,
	type LibraryDiagnostic,
	type PortableLibraryV3Document
} from './types.js';

class StrictJsonParser {
	private offset = 0;
	constructor(private readonly source: string) {}

	parse(): unknown {
		const value = this.value(0, '');
		this.space();
		if (this.offset !== this.source.length)
			this.fail('', 'invalid_json', 'Unexpected trailing input');
		return value;
	}

	private value(depth: number, path: string): unknown {
		if (depth > LIBRARY_V3_MAX_DEPTH)
			this.fail(path, 'maximum_depth', `JSON nesting exceeds ${LIBRARY_V3_MAX_DEPTH}`);
		this.space();
		const char = this.source[this.offset];
		if (char === '{') return this.object(depth + 1, path);
		if (char === '[') return this.array(depth + 1, path);
		if (char === '"') return this.string(path);
		if (char === 't' && this.take('true')) return true;
		if (char === 'f' && this.take('false')) return false;
		if (char === 'n' && this.take('null')) return null;
		if (char === '-' || (char >= '0' && char <= '9')) return this.number(path);
		this.fail(path, 'invalid_json', 'Expected a JSON value');
	}

	private object(depth: number, path: string): Record<string, unknown> {
		this.offset++;
		const result: Record<string, unknown> = Object.create(null);
		const keys = new Set<string>();
		this.space();
		if (this.source[this.offset] === '}') {
			this.offset++;
			return result;
		}
		while (true) {
			this.space();
			if (this.source[this.offset] !== '"')
				this.fail(path, 'invalid_json', 'Expected an object key');
			const key = this.string(path);
			const keyPath = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
			if (keys.has(key))
				this.fail(keyPath, 'duplicate_key', `Duplicate object key ${JSON.stringify(key)}`);
			keys.add(key);
			this.space();
			if (this.source[this.offset++] !== ':')
				this.fail(keyPath, 'invalid_json', 'Expected colon after object key');
			result[key] = this.value(depth, keyPath);
			this.space();
			const separator = this.source[this.offset++];
			if (separator === '}') return result;
			if (separator !== ',') this.fail(path, 'invalid_json', 'Expected comma or closing brace');
		}
	}

	private array(depth: number, path: string): unknown[] {
		this.offset++;
		const result: unknown[] = [];
		this.space();
		if (this.source[this.offset] === ']') {
			this.offset++;
			return result;
		}
		while (true) {
			result.push(this.value(depth, `${path}/${result.length}`));
			this.space();
			const separator = this.source[this.offset++];
			if (separator === ']') return result;
			if (separator !== ',') this.fail(path, 'invalid_json', 'Expected comma or closing bracket');
		}
	}

	private string(path: string): string {
		const start = this.offset++;
		while (this.offset < this.source.length) {
			const code = this.source.charCodeAt(this.offset);
			if (code === 0x22) {
				this.offset++;
				let value: string;
				try {
					value = JSON.parse(this.source.slice(start, this.offset)) as string;
				} catch {
					this.fail(path, 'invalid_json', 'Invalid JSON string escape');
				}
				for (let i = 0; i < value.length; i++) {
					const unit = value.charCodeAt(i);
					if (unit >= 0xd800 && unit <= 0xdbff) {
						const next = value.charCodeAt(++i);
						if (!(next >= 0xdc00 && next <= 0xdfff))
							this.fail(path, 'invalid_unicode', 'Lone UTF-16 surrogate is not allowed');
					} else if (unit >= 0xdc00 && unit <= 0xdfff)
						this.fail(path, 'invalid_unicode', 'Lone UTF-16 surrogate is not allowed');
				}
				return value;
			}
			if (code < 0x20) this.fail(path, 'invalid_json', 'Unescaped control character in string');
			if (code === 0x5c) this.offset++;
			this.offset++;
		}
		this.fail(path, 'invalid_json', 'Unterminated JSON string');
	}

	private number(path: string): number {
		const rest = this.source.slice(this.offset);
		const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
		if (!match) this.fail(path, 'invalid_json', 'Invalid number');
		this.offset += match[0].length;
		const value = Number(match[0]);
		if (!Number.isFinite(value)) this.fail(path, 'invalid_number', 'Numbers must be finite');
		return value;
	}

	private take(word: string): boolean {
		if (!this.source.startsWith(word, this.offset)) return false;
		this.offset += word.length;
		return true;
	}

	private space() {
		while (/[ \t\r\n]/.test(this.source[this.offset] ?? 'x')) this.offset++;
	}
	private fail(path: string, code: string, message: string): never {
		throw new LibraryValidationError([{ path, code, message }]);
	}
}

const TOP_LEVEL = {
	workflow: [
		'format',
		'version',
		'profile',
		'exported_at',
		'digest',
		'main_workflow_id',
		'workflows',
		'context',
		'inputs',
		'text_uses',
		'schedules',
		'routing'
	],
	library: [
		'format',
		'version',
		'profile',
		'exported_at',
		'digest',
		'projects',
		'labels',
		'workflows',
		'context'
	]
} as const;

function structuralDocument(
	value: unknown,
	allowMissingDigest: boolean
): PortableLibraryV3Document {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new LibraryValidationError([
			{ path: '', code: 'invalid_document', message: 'Library document must be an object' }
		]);
	const object = value as Record<string, unknown>;
	if (object.format !== 'tines.library')
		throw new LibraryValidationError([
			{ path: '/format', code: 'invalid_format', message: 'Expected tines.library' }
		]);
	if (object.version !== 3)
		throw new LibraryValidationError([
			{
				path: '/version',
				code: 'unsupported_version',
				message: `Unsupported library version ${String(object.version)}`
			}
		]);
	if (object.profile !== 'workflow' && object.profile !== 'library')
		throw new LibraryValidationError([
			{ path: '/profile', code: 'invalid_profile', message: 'Expected workflow or library profile' }
		]);
	const allowed: readonly string[] = TOP_LEVEL[object.profile];
	const unknown = Object.keys(object).find((key) => !allowed.includes(key));
	if (unknown)
		throw new LibraryValidationError([
			{ path: `/${unknown}`, code: 'unknown_field', message: `Unknown field ${unknown}` }
		]);
	if (!Number.isSafeInteger(object.exported_at) || (object.exported_at as number) < 0)
		throw new LibraryValidationError([
			{
				path: '/exported_at',
				code: 'invalid_integer',
				message: 'exported_at must be a non-negative safe integer'
			}
		]);
	if (
		!(allowMissingDigest && object.digest === undefined) &&
		(typeof object.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(object.digest))
	)
		throw new LibraryValidationError([
			{
				path: '/digest',
				code: 'invalid_digest',
				message: 'digest must be sha256 followed by 64 lowercase hex characters'
			}
		]);
	for (const key of allowed) {
		if (key === 'digest' && allowMissingDigest) continue;
		if (!(key in object))
			throw new LibraryValidationError([
				{ path: `/${key}`, code: 'missing_field', message: `Missing required field ${key}` }
			]);
	}
	return {
		...object,
		digest: typeof object.digest === 'string' ? object.digest : ''
	} as unknown as PortableLibraryV3Document;
}

export async function parseLibraryV3Document(
	input: string | Uint8Array,
	options: { allowMissingDigest?: boolean } = {}
): Promise<PortableLibraryV3Document> {
	const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
	if (bytes.byteLength > LIBRARY_MAX_BYTES)
		throw new LibraryValidationError([
			{
				path: '',
				code: 'package_too_large',
				message: `Document exceeds ${LIBRARY_MAX_BYTES} bytes`
			}
		]);
	let source: string;
	try {
		source =
			typeof input === 'string'
				? input
				: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
	} catch {
		throw new LibraryValidationError([
			{ path: '', code: 'invalid_utf8', message: 'Document is not valid UTF-8' }
		]);
	}
	const document = structuralDocument(
		new StrictJsonParser(source).parse(),
		options.allowMissingDigest ?? false
	);
	validateLibraryV3References(document);
	const actual = await libraryDocumentDigest(document);
	if (document.digest && document.digest !== actual)
		throw new LibraryValidationError([
			{
				path: '/digest',
				code: 'digest_mismatch',
				message: `Document digest does not match; expected ${actual}`
			}
		]);
	return { ...document, digest: actual };
}

export function diagnosticOf(error: unknown): LibraryDiagnostic[] {
	return error instanceof LibraryValidationError
		? error.diagnostics
		: [
				{
					path: '',
					code: 'invalid_document',
					message: error instanceof Error ? error.message : String(error)
				}
			];
}
