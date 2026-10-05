/**
 * The `.tinespack` archive (specs/packs/MVP_SPEC.md, "The archive"): path
 * normalization, operating-system clutter, zip read/write and the digest.
 *
 * Pure and runtime-neutral: it runs in the Worker, the CLI bundle and the
 * browser, so it uses fflate's synchronous inflate/deflate and
 * `globalThis.crypto.subtle`, never `node:` modules.
 *
 * Reading parses the zip's central directory itself rather than calling
 * fflate's `unzipSync`, because `unzipSync` keys its result by name (so a
 * duplicate entry would silently replace the first), decodes names without
 * the UTF-8 flag as Latin-1, and does not expose the external attributes
 * that mark a symlink. Each entry's data is still inflated by fflate.
 */
import { inflateSync, zipSync, type Zippable } from 'fflate';
import { PACK_ARCHIVE_MAX_BYTES, type PackFile, type PackIssue } from './types.js';

// ---------------------------------------------------------------------------
// Clutter

const CLUTTER_BASENAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/**
 * Operating-system clutter, ignored wherever it appears: anything under a
 * `__MACOSX` folder, `.DS_Store`, AppleDouble `._*` files, `Thumbs.db` and
 * `desktop.ini` (the three fixed names compared case-insensitively, as the
 * systems that write them do).
 */
export const CLUTTER = {
	folders: ['__MACOSX'] as readonly string[],
	basenames: ['.DS_Store', 'Thumbs.db', 'desktop.ini'] as readonly string[],
	basenamePrefixes: ['._'] as readonly string[]
} as const;

/** True when `path` is operating-system clutter that packs ignore. */
export function isPackClutterPath(path: string): boolean {
	const segments = path.split(/[/\\]/);
	if (segments.some((s) => CLUTTER.folders.includes(s))) return true;
	const base = segments.filter((s) => s !== '').pop() ?? '';
	if (CLUTTER_BASENAMES.has(base.toLowerCase())) return true;
	return CLUTTER.basenamePrefixes.some((p) => base.startsWith(p));
}

// ---------------------------------------------------------------------------
// Normalization

const issue = (code: string, path: string | null, message: string): PackIssue => ({
	level: 'error',
	code,
	path,
	message
});

/** Why `path` is not an acceptable pack path, or null when it is. */
function pathProblem(path: string): string | null {
	if (path === '') return 'the path is empty';
	if (path.includes('\\')) return 'paths use "/", not "\\"';
	if (path.includes('\0')) return 'paths cannot contain NUL';
	if (path.startsWith('/')) return 'paths must be relative (no leading "/")';
	if (/^[A-Za-z]:/.test(path)) return 'paths cannot be absolute';
	const segments = path.split('/');
	if (segments.some((s) => s === '')) return 'paths cannot have empty segments';
	if (segments.some((s) => s === '.' || s === '..'))
		return 'paths cannot contain "." or ".." segments';
	return null;
}

const byPath = (a: PackFile, b: PackFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * Normalizes a pack's files: drops clutter and directory entries, rejects
 * bad paths, strips a single top-level folder (when every file is inside the
 * same one and none is at the root), reports duplicates and paths that
 * differ only by case, and sorts by path (UTF-16 code unit order).
 *
 * Files with a bad path, and every file of a duplicate or case-colliding
 * group after the first, are left out of `files`.
 */
export function normalizePackFiles(entries: PackFile[]): {
	files: PackFile[];
	errors: PackIssue[];
} {
	const errors: PackIssue[] = [];
	const kept: PackFile[] = [];
	for (const entry of entries) {
		if (isPackClutterPath(entry.path)) continue;
		if (entry.path.endsWith('/')) continue; // a directory entry
		const problem = pathProblem(entry.path);
		if (problem) {
			errors.push(issue('invalid_path', entry.path, `"${entry.path}": ${problem}`));
			continue;
		}
		kept.push(entry);
	}

	let files = kept;
	if (files.length > 0 && files.every((f) => f.path.includes('/'))) {
		const top = files[0].path.slice(0, files[0].path.indexOf('/') + 1);
		if (files.every((f) => f.path.startsWith(top))) {
			files = files.map((f) => ({ path: f.path.slice(top.length), bytes: f.bytes }));
		}
	}

	files = [...files].sort(byPath);
	const out: PackFile[] = [];
	const seenExact = new Set<string>();
	const seenFolded = new Map<string, string>();
	for (const f of files) {
		if (seenExact.has(f.path)) {
			errors.push(issue('duplicate_path', f.path, `"${f.path}" appears more than once`));
			continue;
		}
		seenExact.add(f.path);
		const folded = f.path.toLowerCase();
		const other = seenFolded.get(folded);
		if (other !== undefined) {
			errors.push(
				issue(
					'case_collision',
					f.path,
					`"${f.path}" and "${other}" differ only by case, which breaks on case-insensitive file systems`
				)
			);
			continue;
		}
		seenFolded.set(folded, f.path);
		out.push(f);
	}
	return { files: out, errors };
}

// ---------------------------------------------------------------------------
// Reading

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Reads a `.tinespack` (zip) into normalized files. Refuses archives over
 * `PACK_ARCHIVE_MAX_BYTES` compressed or in total uncompressed, zip64,
 * encryption, compression other than stored/deflate, symlinks (Unix mode in
 * the external attributes), non-UTF-8 names, and entries whose CRC does not
 * match. Every problem is collected; a structurally unreadable zip returns
 * one `invalid_archive` error and no files.
 */
export function readPackArchive(bytes: Uint8Array): { files: PackFile[]; errors: PackIssue[] } {
	const fail = (code: string, message: string) => ({
		files: [],
		errors: [issue(code, null, message)]
	});
	if (bytes.length > PACK_ARCHIVE_MAX_BYTES) {
		return fail(
			'archive_too_large',
			`The archive is ${bytes.length} bytes; a pack can be at most ${PACK_ARCHIVE_MAX_BYTES}`
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u16 = (o: number) => view.getUint16(o, true);
	const u32 = (o: number) => view.getUint32(o, true);

	// End of central directory: the last 22+ bytes, before an optional comment.
	let eocd = -1;
	for (let o = bytes.length - 22; o >= Math.max(0, bytes.length - 22 - 0xffff); o--) {
		if (u32(o) === 0x06054b50) {
			eocd = o;
			break;
		}
	}
	if (eocd < 0) return fail('invalid_archive', 'The file is not a zip archive');
	const count = u16(eocd + 10);
	const cdSize = u32(eocd + 12);
	const cdOffset = u32(eocd + 16);
	if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
		return fail('invalid_archive', 'Zip64 archives are not supported');
	}
	if (cdOffset + cdSize > eocd) return fail('invalid_archive', 'The zip directory is corrupt');

	interface Entry {
		name: string;
		method: number;
		compSize: number;
		size: number;
		crc: number;
		localOffset: number;
	}
	const entries: Entry[] = [];
	const errors: PackIssue[] = [];
	let o = cdOffset;
	let declaredTotal = 0;
	for (let i = 0; i < count; i++) {
		if (o + 46 > eocd || u32(o) !== 0x02014b50) {
			return fail('invalid_archive', 'The zip directory is corrupt');
		}
		const madeBy = u16(o + 4);
		const flags = u16(o + 8);
		const method = u16(o + 10);
		const crc = u32(o + 16);
		const compSize = u32(o + 20);
		const size = u32(o + 24);
		const nameLen = u16(o + 28);
		const extraLen = u16(o + 30);
		const commentLen = u16(o + 32);
		const attrs = u32(o + 38);
		const localOffset = u32(o + 42);
		const rawName = bytes.subarray(o + 46, o + 46 + nameLen);
		o += 46 + nameLen + extraLen + commentLen;

		let name: string;
		try {
			name = UTF8.decode(rawName);
		} catch {
			errors.push(issue('invalid_path', null, 'An entry name is not valid UTF-8'));
			continue;
		}
		if (isPackClutterPath(name) || name.endsWith('/')) continue;
		if (madeBy >> 8 === 3 && ((attrs >>> 16) & S_IFMT) === S_IFLNK) {
			errors.push(issue('symlink', name, `"${name}" is a symlink; packs cannot contain symlinks`));
			continue;
		}
		if (flags & 1) {
			errors.push(issue('invalid_archive', name, `"${name}" is encrypted`));
			continue;
		}
		if (method !== 0 && method !== 8) {
			errors.push(
				issue('invalid_archive', name, `"${name}" uses an unsupported compression method`)
			);
			continue;
		}
		declaredTotal += size;
		entries.push({ name, method, compSize, size, crc, localOffset });
	}
	if (declaredTotal > PACK_ARCHIVE_MAX_BYTES) {
		return fail(
			'archive_too_large',
			`The archive unpacks to ${declaredTotal} bytes; a pack can be at most ${PACK_ARCHIVE_MAX_BYTES}`
		);
	}

	const files: PackFile[] = [];
	for (const e of entries) {
		const lo = e.localOffset;
		if (lo + 30 > bytes.length || u32(lo) !== 0x04034b50) {
			errors.push(issue('invalid_archive', e.name, `"${e.name}" is corrupt`));
			continue;
		}
		const start = lo + 30 + u16(lo + 26) + u16(lo + 28);
		if (start + e.compSize > bytes.length) {
			errors.push(issue('invalid_archive', e.name, `"${e.name}" is truncated`));
			continue;
		}
		const raw = bytes.subarray(start, start + e.compSize);
		let data: Uint8Array;
		try {
			// A fixed output buffer of the declared size bounds memory whatever
			// the compressed stream claims; the length and CRC checks below
			// catch a stream that disagrees with its header.
			data =
				e.method === 0
					? raw.slice()
					: e.size === 0
						? new Uint8Array(0)
						: inflateSync(raw, { out: new Uint8Array(e.size) });
		} catch {
			errors.push(issue('invalid_archive', e.name, `"${e.name}" could not be decompressed`));
			continue;
		}
		if (data.length !== e.size || crc32(data) !== e.crc) {
			errors.push(issue('invalid_archive', e.name, `"${e.name}" is corrupt (CRC mismatch)`));
			continue;
		}
		files.push({ path: e.name, bytes: data });
	}

	const normalized = normalizePackFiles(files);
	return { files: normalized.files, errors: [...errors, ...normalized.errors] };
}

// ---------------------------------------------------------------------------
// Writing

/**
 * Zips `files` under one top-level folder. Deterministic: entries sorted by
 * path, a fixed 1980-01-01 00:00 timestamp (built from local-time fields,
 * because zip stores local DOS time), Unix 0644 attributes and deflate level
 * 6, so the same files always give the same bytes. Clutter is never written.
 */
export function writePackArchive(files: PackFile[], folderName: string): Uint8Array {
	const mtime = new Date(1980, 0, 1, 0, 0, 0);
	const input: Zippable = {};
	for (const f of [...files].sort(byPath)) {
		if (isPackClutterPath(f.path)) continue;
		input[`${folderName}/${f.path}`] = [
			f.bytes,
			{ level: 6, mtime, os: 3, attrs: (0o100644 << 16) >>> 0 }
		];
	}
	return zipSync(input);
}

/**
 * A safe folder name for a pack: the last `/`-separated segment of its id,
 * with anything outside `[A-Za-z0-9._-]` replaced by `-` and leading or
 * trailing dots and dashes trimmed (`pack` when nothing is left).
 */
export function packFolderName(id: string): string {
	const last =
		id
			.split('/')
			.filter((s) => s !== '')
			.pop() ?? '';
	const cleaned = last.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
	return cleaned || 'pack';
}

// ---------------------------------------------------------------------------
// Digest

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(
		await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
	);
	let out = '';
	for (const b of digest) out += HEX[b];
	return out;
}

/**
 * SHA-256 (lowercase hex) over the sorted list of `<path>\0<sha256 hex of
 * bytes>\n` lines. Independent of zip order, compression and timestamps.
 * Expects normalized files; clutter is skipped defensively.
 */
export async function packDigest(files: PackFile[]): Promise<string> {
	const lines: string[] = [];
	for (const f of [...files].sort(byPath)) {
		if (isPackClutterPath(f.path)) continue;
		lines.push(`${f.path}\0${await sha256Hex(f.bytes)}\n`);
	}
	return sha256Hex(new TextEncoder().encode(lines.join('')));
}
