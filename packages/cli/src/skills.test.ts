import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EffectiveSkill } from '@tines/shared';
import { assertNoSkillRepoOverlap, materializeSkills, SKILLS_DIRECTORY } from './skills.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const value = mkdtempSync(join(tmpdir(), 'tines-skills-'));
	roots.push(value);
	return value;
}

function skill(name: string, files: Array<{ path: string; content: string }>): EffectiveSkill {
	return {
		item_id: `ctx_${name}`,
		name,
		description: '',
		scope: {
			project_id: null,
			project_name: null,
			workflow_state_id: null,
			workflow_state_name: null,
			workflow_id: null,
			workflow_name: null,
			label_id: null,
			label_name: null,
			label_color: null,
			issue_id: null,
			issue_ref: null,
			label: 'global'
		},
		files,
		file_count: files.length,
		version: 1,
		inherited_from: null
	};
}

describe('materializeSkills', () => {
	it('writes nested files byte-for-byte and preserves empty skill directories', () => {
		const workspace = root();
		const body = '---\nname: alpha\ndescription: x\n---\n\n$VALUE\\n\u0000';
		materializeSkills(workspace, [
			skill('alpha', [
				{ path: 'SKILL.md', content: body },
				{ path: 'references/note.txt', content: 'support' }
			]),
			skill('empty', [])
		]);

		expect(readFileSync(join(workspace, SKILLS_DIRECTORY, 'alpha/SKILL.md'), 'utf8')).toBe(body);
		expect(
			readFileSync(join(workspace, SKILLS_DIRECTORY, 'alpha/references/note.txt'), 'utf8')
		).toBe('support');
		expect(existsSync(join(workspace, SKILLS_DIRECTORY, 'empty'))).toBe(true);
	});

	it('replaces the complete generated set while preserving .agents siblings and legacy skills', () => {
		const workspace = root();
		mkdirSync(join(workspace, '.agents'), { recursive: true });
		writeFileSync(join(workspace, '.agents', 'settings.json'), '{}');
		mkdirSync(join(workspace, 'skills/legacy'), { recursive: true });
		writeFileSync(join(workspace, 'skills/legacy/SKILL.md'), 'legacy');
		materializeSkills(workspace, [
			skill('old', [
				{ path: 'SKILL.md', content: 'old' },
				{ path: 'stale.txt', content: 'stale' }
			])
		]);

		materializeSkills(workspace, [skill('new', [{ path: 'SKILL.md', content: 'new' }])]);
		expect(existsSync(join(workspace, SKILLS_DIRECTORY, 'old'))).toBe(false);
		expect(readFileSync(join(workspace, SKILLS_DIRECTORY, 'new/SKILL.md'), 'utf8')).toBe('new');
		expect(readFileSync(join(workspace, '.agents/settings.json'), 'utf8')).toBe('{}');
		expect(readFileSync(join(workspace, 'skills/legacy/SKILL.md'), 'utf8')).toBe('legacy');

		materializeSkills(workspace, []);
		expect(existsSync(join(workspace, SKILLS_DIRECTORY))).toBe(true);
		expect(existsSync(join(workspace, SKILLS_DIRECTORY, 'new'))).toBe(false);
	});

	it.each([
		['bad/name', 'SKILL.md'],
		['good', '../escape'],
		['good', '/absolute'],
		['good', 'a//b'],
		['good', 'a\\b'],
		['good', 'a=b']
	])('rejects unsafe name/path %s %s before replacing the old tree', (name, path) => {
		const workspace = root();
		materializeSkills(workspace, [skill('safe', [{ path: 'SKILL.md', content: 'old' }])]);
		expect(() => materializeSkills(workspace, [skill(name, [{ path, content: 'bad' }])])).toThrow();
		expect(readFileSync(join(workspace, SKILLS_DIRECTORY, 'safe/SKILL.md'), 'utf8')).toBe('old');
	});

	it.each(['.agents', '.agents/skills'])('rejects a symlink at %s without following it', (path) => {
		const workspace = root();
		const outside = root();
		writeFileSync(join(outside, 'sentinel'), 'safe');
		if (path === '.agents/skills') mkdirSync(join(workspace, '.agents'));
		symlinkSync(outside, join(workspace, path));
		expect(() => materializeSkills(workspace, [])).toThrow(/symlink/);
		expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('safe');
	});
});

describe('assertNoSkillRepoOverlap', () => {
	it.each(['.agents', '.agents/skills', '.agents/skills/repo'])(
		'rejects overlapping repo dir %s',
		(dir) => {
			expect(() => assertNoSkillRepoOverlap([dir])).toThrow(/overlaps/);
		}
	);

	it('allows sibling checkout directories', () => {
		expect(() => assertNoSkillRepoOverlap(['repo', '.agents/cache'])).not.toThrow();
	});
});
