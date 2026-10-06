import { zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
	normalizePackFiles,
	packDigest,
	packFolderName,
	readPackArchive,
	writePackArchive
} from './archive.js';
import { engineeringPack } from './engineering-fixture.js';
import { parsePack } from './parse.js';
import { PACK_ARCHIVE_MAX_BYTES, type PackFile } from './types.js';
import { packFilesFromRecord } from './write.js';

const enc = new TextEncoder();
const file = (path: string, text = path): PackFile => ({ path, bytes: enc.encode(text) });
const paths = (files: PackFile[]) => files.map((f) => f.path);
const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

describe('normalizePackFiles', () => {
	it('drops clutter and directory entries and sorts', () => {
		const r = normalizePackFiles([
			file('b.md'),
			file('__MACOSX/._b.md'),
			file('x/__MACOSX/y'),
			file('.DS_Store'),
			file('project/.DS_Store'),
			file('project/._conventions.md'),
			file('Thumbs.db'),
			file('shared/DESKTOP.INI'),
			file('project/'),
			file('a.md')
		]);
		expect(r.errors).toEqual([]);
		expect(paths(r.files)).toEqual(['a.md', 'b.md']);
	});

	it('strips one top-level folder, ignoring clutter beside it', () => {
		const r = normalizePackFiles([
			file('engineering/pack.yaml'),
			file('engineering/project/a.md'),
			file('__MACOSX/engineering/._pack.yaml'),
			file('.DS_Store')
		]);
		expect(paths(r.files)).toEqual(['pack.yaml', 'project/a.md']);
	});

	it('does not strip when a file is at the root or there are two folders', () => {
		expect(paths(normalizePackFiles([file('a/x.md'), file('b/y.md')]).files)).toEqual([
			'a/x.md',
			'b/y.md'
		]);
		expect(paths(normalizePackFiles([file('a/x.md'), file('pack.yaml')]).files)).toEqual([
			'a/x.md',
			'pack.yaml'
		]);
	});

	it.each([
		'/abs.md',
		'C:/x.md',
		'a\\b.md',
		'../up.md',
		'a/../b.md',
		'./a.md',
		'a//b.md',
		'a/./b.md'
	])('rejects the path %s', (path) => {
		const r = normalizePackFiles([file(path), file('pack.yaml')]);
		expect(codes(r)).toEqual(['invalid_path']);
		expect(paths(r.files)).toEqual(['pack.yaml']);
	});

	it('rejects duplicates and paths differing only by case', () => {
		const r = normalizePackFiles([file('pack.yaml'), file('a.md'), file('a.md'), file('A.md')]);
		expect(codes(r).sort()).toEqual(['case_collision', 'duplicate_path']);
		expect(paths(r.files)).toEqual(['A.md', 'pack.yaml']);
	});
});

describe('packFolderName', () => {
	it.each([
		['tbuckley/engineering', 'engineering'],
		['engineering', 'engineering'],
		['acme/my pack!', 'my-pack'],
		['acme/..', 'pack'],
		['a.b_c-d', 'a.b_c-d']
	])('%s → %s', (id, name) => expect(packFolderName(id)).toBe(name));
});

describe('archive round trip and digest', () => {
	const files = packFilesFromRecord(engineeringPack());

	it('reads back what it writes, under one top folder', () => {
		const zip = writePackArchive(files, 'engineering');
		const r = readPackArchive(zip);
		expect(r.errors).toEqual([]);
		expect(r.files).toEqual(files);
	});

	it('writes the same bytes for the same files, in any order', () => {
		const a = writePackArchive(files, 'engineering');
		const b = writePackArchive([...files].reverse(), 'engineering');
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
	});

	it('never writes clutter', () => {
		const zip = writePackArchive([...files, file('project/.DS_Store')], 'engineering');
		expect(readPackArchive(zip).files).toEqual(files);
	});

	it('digest ignores zip order, compression, timestamps, clutter and the top folder', async () => {
		const expected = await packDigest(files);
		expect(expected).toMatch(/^[0-9a-f]{64}$/);

		const reordered: Zippable = {};
		for (const f of [...files].reverse()) {
			reordered[f.path] = [f.bytes, { level: 0, mtime: new Date(2024, 5, 1) }];
		}
		reordered['__MACOSX/._pack.yaml'] = enc.encode('junk');
		reordered['.DS_Store'] = enc.encode('junk');
		reordered['project/Thumbs.db'] = enc.encode('junk');
		const flat = readPackArchive(zipSync(reordered));
		expect(flat.errors).toEqual([]);
		expect(await packDigest(flat.files)).toBe(expected);

		const nested: Zippable = { '__MACOSX/pack/._pack.yaml': enc.encode('junk') };
		for (const f of files) nested[`pack/${f.path}`] = [f.bytes, { level: 9 }];
		const fromNested = readPackArchive(zipSync(nested));
		expect(await packDigest(fromNested.files)).toBe(expected);

		const parsed = await parsePack(fromNested.files);
		expect(parsed.digest).toBe(expected);
	});

	it('digest changes with content', async () => {
		const changed = files.map((f) => (f.path === 'README.md' ? file('README.md', 'other') : f));
		expect(await packDigest(changed)).not.toBe(await packDigest(files));
	});
});

describe('readPackArchive refusals', () => {
	it('refuses symlinks', () => {
		const zip = zipSync({
			'pack.yaml': enc.encode('format: 1'),
			'project/link.md': [enc.encode('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }]
		});
		const r = readPackArchive(zip);
		expect(codes(r)).toEqual(['symlink']);
		expect(paths(r.files)).toEqual(['pack.yaml']);
	});

	it('refuses archives over the size cap, compressed or not', () => {
		expect(codes(readPackArchive(new Uint8Array(PACK_ARCHIVE_MAX_BYTES + 1)))).toEqual([
			'archive_too_large'
		]);
		const bomb = zipSync({ 'big.txt': [new Uint8Array(PACK_ARCHIVE_MAX_BYTES + 1), { level: 9 }] });
		expect(bomb.length).toBeLessThan(PACK_ARCHIVE_MAX_BYTES);
		expect(codes(readPackArchive(bomb))).toEqual(['archive_too_large']);
	});

	it('refuses non-zips and corrupt entries', () => {
		expect(codes(readPackArchive(enc.encode('not a zip')))).toEqual(['invalid_archive']);
		const zip = zipSync({ 'pack.yaml': [enc.encode('format: 1\n'.repeat(50)), { level: 0 }] });
		const i = Buffer.from(zip).indexOf('format: 1');
		zip[i] = 'F'.charCodeAt(0);
		expect(codes(readPackArchive(zip))).toEqual(['invalid_archive']);
	});

	it('normalizes paths read from the zip', () => {
		const r = readPackArchive(
			zipSync({ 'a/../pack.yaml': enc.encode('x'), 'pack.yaml': enc.encode('x') })
		);
		expect(codes(r)).toEqual(['invalid_path']);
	});
});
