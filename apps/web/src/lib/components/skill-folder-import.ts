import { SKILL_MAX_FILES, SKILL_MAX_TOTAL_BYTES, type ContextFile } from '@tines/shared';

export interface SkillFolderSource {
	name: string;
	webkitRelativePath: string;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SkippedSkillFile {
	path: string;
	reason: string;
}

export interface SkillDraftRow extends ContextFile {
	key: number;
}

export interface SkillDraftValidation {
	fileCount: number;
	totalBytes: number;
	error: string | null;
}

export class SkillFolderImportCancelled extends Error {
	constructor() {
		super('Folder import was cancelled');
		this.name = 'SkillFolderImportCancelled';
	}
}

const byteLength = (value: string) => new TextEncoder().encode(value).length;

/** Keep this in parity with the API's validateWorkspacePath rules. */
export function skillFilePathError(path: string): string | null {
	if (path.trim().length === 0) return 'paths must not be empty or whitespace-only';
	if (path.length > 500) return 'paths must be at most 500 characters';
	if (path.includes('\\')) return 'use forward slashes';
	if (path.startsWith('/')) return 'paths must be relative (no leading "/")';
	if (path.includes('=')) return 'paths cannot contain "="';
	const segments = path.split('/');
	if (segments.some((segment) => segment === ''))
		return 'paths cannot have empty segments or trailing slashes';
	if (segments.some((segment) => segment === '.' || segment === '..'))
		return 'paths cannot contain "." or ".." segments';
	return null;
}

function ignoredReason(path: string): string | null {
	const segments = path.split('/');
	if (segments.at(-1) === '.DS_Store') return '.DS_Store metadata';
	if (segments.includes('.git')) return '.git directory';
	if (segments.includes('node_modules')) return 'node_modules directory';
	return null;
}

export async function readSkillFolder(
	sources: readonly SkillFolderSource[],
	isCancelled: () => boolean = () => false
): Promise<{ files: ContextFile[]; skipped: SkippedSkillFile[] }> {
	if (sources.length === 0) return { files: [], skipped: [] };

	let root: string | null = null;
	const normalized: { source: SkillFolderSource; path: string }[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		const relative = source.webkitRelativePath;
		const slash = relative.indexOf('/');
		if (!relative || slash <= 0 || slash === relative.length - 1) {
			throw new Error('Select one skill folder; directory path metadata is missing.');
		}
		const sourceRoot = relative.slice(0, slash);
		if (root === null) root = sourceRoot;
		if (sourceRoot !== root) throw new Error('Select one skill folder.');
		const path = relative.slice(slash + 1);
		if (seen.has(path)) throw new Error(`The selected folder contains duplicate path “${path}”.`);
		seen.add(path);
		normalized.push({ source, path });
	}

	const retained: { source: SkillFolderSource; path: string }[] = [];
	const skipped: SkippedSkillFile[] = [];
	for (const entry of normalized) {
		const reason = ignoredReason(entry.path);
		if (reason) {
			skipped.push({ path: entry.path, reason });
			continue;
		}
		const pathError = skillFilePathError(entry.path);
		if (pathError) throw new Error(`Invalid file path “${entry.path}”: ${pathError}.`);
		retained.push(entry);
	}
	if (!retained.some(({ path }) => path === 'SKILL.md')) {
		throw new Error('The selected folder must contain SKILL.md at its root.');
	}

	const files: ContextFile[] = [];
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	for (const { source, path } of retained) {
		if (isCancelled()) throw new SkillFolderImportCancelled();
		try {
			const content = decoder.decode(await source.arrayBuffer());
			if (content.includes('\0')) throw new Error('contains a NUL character');
			files.push({ path, content });
		} catch (error) {
			if (isCancelled()) throw new SkillFolderImportCancelled();
			const detail = error instanceof Error ? error.message : 'could not be read';
			throw new Error(
				`Couldn’t import “${path}” (${detail}). Remove it from the folder or convert it to UTF-8, then retry.`
			);
		}
	}
	if (isCancelled()) throw new SkillFolderImportCancelled();
	return { files, skipped };
}

export function mergeSkillFiles(
	existing: readonly SkillDraftRow[],
	incoming: readonly ContextFile[],
	nextKey: () => number
): { rows: SkillDraftRow[]; added: number; replaced: number } {
	const existingPaths = new Set<string>();
	for (const row of existing) {
		if (!row.path) continue;
		if (existingPaths.has(row.path)) {
			throw new Error(`Rename or remove duplicate draft path “${row.path}” before importing.`);
		}
		existingPaths.add(row.path);
	}
	const incomingByPath = new Map(incoming.map((file) => [file.path, file]));
	let replaced = 0;
	const rows = existing.map((row) => {
		const replacement = incomingByPath.get(row.path);
		if (!replacement) return { ...row };
		incomingByPath.delete(row.path);
		replaced += 1;
		return { ...row, content: replacement.content };
	});
	const additions = [...incomingByPath.values()]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((file) => ({ key: nextKey(), ...file }));
	return { rows: [...rows, ...additions], added: additions.length, replaced };
}

export function validateSkillDraft(
	files: readonly Pick<ContextFile, 'path' | 'content'>[],
	requiresRootSkill: boolean
): SkillDraftValidation {
	let totalBytes = 0;
	const seen = new Set<string>();
	let error: string | null = null;
	for (const file of files) {
		totalBytes += byteLength(file.path) + byteLength(file.content);
		const pathError = skillFilePathError(file.path);
		if (!error && pathError) error = `Invalid file path “${file.path}”: ${pathError}.`;
		if (!error && seen.has(file.path)) error = `File path “${file.path}” is listed more than once.`;
		seen.add(file.path);
	}
	if (!error && requiresRootSkill && !files.some(({ path }) => path === 'SKILL.md')) {
		error = 'Restore SKILL.md at the folder root before saving.';
	}
	if (!error && files.length > SKILL_MAX_FILES) {
		error = `Remove files: a skill can contain at most ${SKILL_MAX_FILES}.`;
	}
	if (!error && totalBytes > SKILL_MAX_TOTAL_BYTES) {
		error = `Remove files or shorten content: a skill can contain at most ${SKILL_MAX_TOTAL_BYTES.toLocaleString()} UTF-8 bytes.`;
	}
	return { fileCount: files.length, totalBytes, error };
}
