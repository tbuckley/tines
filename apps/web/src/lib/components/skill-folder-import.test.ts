import { SKILL_MAX_FILES, SKILL_MAX_TOTAL_BYTES } from '@tines/shared';
import { describe, expect, it, vi } from 'vitest';
import {
	mergeSkillFiles,
	readSkillFolder,
	SkillFolderImportCancelled,
	skillFilePathError,
	validateSkillDraft,
	type SkillFolderSource
} from './skill-folder-import';

const encoder = new TextEncoder();
function source(path: string, content = '', read = vi.fn()): SkillFolderSource {
	return {
		name: path.split('/').at(-1)!,
		webkitRelativePath: path,
		arrayBuffer: async () => {
			read();
			return encoder.encode(content).buffer as ArrayBuffer;
		}
	};
}

describe('readSkillFolder', () => {
	it('keeps nested relative paths and strict text bytes', async () => {
		const result = await readSkillFolder([
			source('chosen/SKILL.md', '\ufeff# Héllo\r\n'),
			source('chosen/a/readme.txt', 'first'),
			source('chosen/b/readme.txt', '')
		]);
		expect(result.files).toEqual([
			{ path: 'SKILL.md', content: '\ufeff# Héllo\r\n' },
			{ path: 'a/readme.txt', content: 'first' },
			{ path: 'b/readme.txt', content: '' }
		]);
	});

	it('reports exact noise while retaining lookalikes and other dotfiles', async () => {
		const ignoredRead = vi.fn();
		const result = await readSkillFolder([
			source('skill/SKILL.md'),
			source('skill/.git/config', '', ignoredRead),
			source('skill/x/node_modules/pkg.js', '', ignoredRead),
			source('skill/x/.DS_Store', '', ignoredRead),
			source('skill/.env.example'),
			source('skill/.github/workflow.yml'),
			source('skill/node_modules-notes/readme.md')
		]);
		expect(result.files.map((file) => file.path)).toEqual([
			'SKILL.md',
			'.env.example',
			'.github/workflow.yml',
			'node_modules-notes/readme.md'
		]);
		expect(result.skipped).toHaveLength(3);
		expect(ignoredRead).not.toHaveBeenCalled();
	});

	it.each([
		[['SKILL.md'], 'directory path metadata is missing'],
		[['one/SKILL.md', 'two/file.txt'], 'Select one skill folder'],
		[['one/nested/SKILL.md'], 'must contain SKILL.md at its root'],
		[['one/skill.md'], 'must contain SKILL.md at its root'],
		[['one/SKILL.md', 'one/SKILL.md'], 'duplicate path']
	])('rejects invalid selection %j', async (paths, message) => {
		await expect(readSkillFolder(paths.map((path) => source(path)))).rejects.toThrow(message);
	});

	it('rejects malformed UTF-8, NULs, and failed reads atomically', async () => {
		const malformed = source('one/bad.bin');
		malformed.arrayBuffer = async () => new Uint8Array([0xff]).buffer;
		await expect(readSkillFolder([source('one/SKILL.md'), malformed])).rejects.toThrow('bad.bin');
		await expect(readSkillFolder([source('one/SKILL.md', '\0')])).rejects.toThrow('NUL');
		const failed = source('one/nope.txt');
		failed.arrayBuffer = async () => {
			throw new Error('disk error');
		};
		await expect(readSkillFolder([source('one/SKILL.md'), failed])).rejects.toThrow('nope.txt');
	});

	it('stops before another read when cancelled', async () => {
		let cancelled = false;
		const secondRead = vi.fn();
		const first = source('one/SKILL.md');
		first.arrayBuffer = async () => {
			cancelled = true;
			return encoder.encode('ok').buffer as ArrayBuffer;
		};
		await expect(
			readSkillFolder([first, source('one/next.txt', '', secondRead)], () => cancelled)
		).rejects.toBeInstanceOf(SkillFolderImportCancelled);
		expect(secondRead).not.toHaveBeenCalled();
	});
});

describe('path, merge, and draft validation', () => {
	it('matches the API path boundaries', () => {
		expect(skillFilePathError('a'.repeat(500))).toBeNull();
		expect(skillFilePathError('a'.repeat(501))).toContain('500');
		for (const path of ['', '  ', '/x', 'a\\b', 'a=b', 'a//b', 'a/./b', 'a/../b']) {
			expect(skillFilePathError(path), path).not.toBeNull();
		}
	});

	it('merges by exact path while preserving row keys, order, and incomplete rows', () => {
		let key = 10;
		const existing = [
			{ key: 1, path: 'z.txt', content: 'edited' },
			{ key: 2, path: '', content: 'unfinished' },
			{ key: 3, path: 'SKILL.md', content: 'old' }
		];
		const first = mergeSkillFiles(
			existing,
			[
				{ path: 'b.txt', content: 'b' },
				{ path: 'SKILL.md', content: 'new' },
				{ path: 'a.txt', content: 'a' }
			],
			() => key++
		);
		expect(first).toMatchObject({ added: 2, replaced: 1 });
		expect(first.rows).toEqual([
			{ key: 1, path: 'z.txt', content: 'edited' },
			{ key: 2, path: '', content: 'unfinished' },
			{ key: 3, path: 'SKILL.md', content: 'new' },
			{ key: 10, path: 'a.txt', content: 'a' },
			{ key: 11, path: 'b.txt', content: 'b' }
		]);
		const repeated = mergeSkillFiles(
			first.rows,
			[{ path: 'a.txt', content: 'again' }],
			() => key++
		);
		expect(repeated).toMatchObject({ added: 0, replaced: 1 });
		expect(repeated.rows.filter((row) => row.path === 'a.txt')).toHaveLength(1);
		expect(() =>
			mergeSkillFiles(
				[
					{ key: 1, path: 'same', content: '' },
					{ key: 2, path: 'same', content: '' }
				],
				[],
				() => key++
			)
		).toThrow('duplicate draft path');
	});

	it('counts UTF-8 path and content bytes at exact limits', () => {
		const exact = validateSkillDraft(
			[{ path: 'SKILL.md', content: 'x'.repeat(SKILL_MAX_TOTAL_BYTES - 8) }],
			true
		);
		expect(exact).toEqual({ fileCount: 1, totalBytes: SKILL_MAX_TOTAL_BYTES, error: null });
		expect(
			validateSkillDraft(
				[{ path: 'SKILL.md', content: `é${'x'.repeat(SKILL_MAX_TOTAL_BYTES - 9)}` }],
				true
			).error
		).toContain('at most');
		expect(
			validateSkillDraft(
				Array.from({ length: SKILL_MAX_FILES }, (_, i) => ({ path: `f${i}`, content: '' })),
				false
			).error
		).toBeNull();
		expect(
			validateSkillDraft(
				Array.from({ length: SKILL_MAX_FILES + 1 }, (_, i) => ({ path: `f${i}`, content: '' })),
				false
			).error
		).toContain('at most 20');
	});

	it('applies the root rule only after an import and clears errors after removal', () => {
		expect(validateSkillDraft([{ path: 'legacy.txt', content: '' }], false).error).toBeNull();
		expect(validateSkillDraft([{ path: 'legacy.txt', content: '' }], true).error).toContain(
			'Restore SKILL.md'
		);
		expect(
			validateSkillDraft(
				[
					{ path: 'SKILL.md', content: '' },
					{ path: 'SKILL.md', content: '' }
				],
				true
			).error
		).toContain('more than once');
	});
});
