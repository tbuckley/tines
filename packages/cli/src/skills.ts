import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SKILL_NAME_PATTERN, type EffectiveSkill } from '@tines/shared';

export const SKILLS_DIRECTORY = '.agents/skills';

function validateRelativePath(value: string, label: string): string[] {
	if (!value || isAbsolute(value) || value.startsWith('/') || value.includes('\\')) {
		throw new Error(`${label} must be a relative path using forward slashes (got "${value}")`);
	}
	if (value.includes('=')) throw new Error(`${label} cannot contain "=" (got "${value}")`);
	const segments = value.split('/');
	if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
		throw new Error(`${label} cannot contain empty, ".", or ".." segments (got "${value}")`);
	}
	return segments;
}

function isPrefix(left: readonly string[], right: readonly string[]): boolean {
	return left.length <= right.length && left.every((segment, index) => segment === right[index]);
}

/** Refuse a checkout that could be removed when the generated skill subtree is replaced. */
export function assertNoSkillRepoOverlap(repoDirs: readonly string[]): void {
	const skills = SKILLS_DIRECTORY.split('/');
	for (const dir of repoDirs) {
		const repo = validateRelativePath(dir, 'Repository checkout directory');
		if (isPrefix(repo, skills) || isPrefix(skills, repo)) {
			throw new Error(
				`Repository checkout directory "${dir}" overlaps generated skill directory "${SKILLS_DIRECTORY}"`
			);
		}
	}
}

function rejectSymlink(path: string, label: string): void {
	if (!existsSync(path)) return;
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
	if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
}

/** Replace only `<root>/.agents/skills` with the complete effective skill set. */
export function materializeSkills(root: string, skills: readonly EffectiveSkill[]): void {
	const seenSkills = new Set<string>();
	for (const skill of skills) {
		if (!SKILL_NAME_PATTERN.test(skill.name)) {
			throw new Error(`Invalid skill name "${skill.name}"; expected [a-z0-9-]+`);
		}
		if (seenSkills.has(skill.name)) throw new Error(`Duplicate skill name "${skill.name}"`);
		seenSkills.add(skill.name);
		const seenFiles = new Set<string>();
		for (const file of skill.files) {
			validateRelativePath(file.path, `Skill "${skill.name}" file path`);
			if (seenFiles.has(file.path)) {
				throw new Error(`Skill "${skill.name}" file path "${file.path}" is duplicated`);
			}
			seenFiles.add(file.path);
		}
	}

	const agentsDir = join(root, '.agents');
	const destination = join(agentsDir, 'skills');
	rejectSymlink(agentsDir, 'Agent metadata directory');
	rejectSymlink(destination, 'Generated skill directory');
	mkdirSync(agentsDir, { recursive: true });

	const suffix = randomUUID();
	const staged = join(agentsDir, `.skills-stage-${suffix}`);
	const backup = join(agentsDir, `.skills-backup-${suffix}`);
	try {
		mkdirSync(staged);
		for (const skill of skills) {
			const skillDir = join(staged, skill.name);
			mkdirSync(skillDir, { recursive: true });
			for (const file of skill.files) {
				const target = resolve(skillDir, ...file.path.split('/'));
				const within = relative(skillDir, target);
				if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
					throw new Error(`Skill "${skill.name}" file escapes its directory: ${file.path}`);
				}
				mkdirSync(resolve(target, '..'), { recursive: true });
				writeFileSync(target, file.content);
			}
		}

		if (existsSync(destination)) renameSync(destination, backup);
		try {
			renameSync(staged, destination);
		} catch (error) {
			if (existsSync(backup) && !existsSync(destination)) renameSync(backup, destination);
			throw error;
		}
		rmSync(backup, { recursive: true, force: true });
	} finally {
		rmSync(staged, { recursive: true, force: true });
		if (existsSync(backup) && !existsSync(destination)) renameSync(backup, destination);
		else rmSync(backup, { recursive: true, force: true });
	}
}
