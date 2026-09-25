import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOADING_STATES } from './loading-states';

const SRC = fileURLToPath(new URL('../..', import.meta.url));
const UI = join(SRC, 'lib', 'components', 'ui');

function svelteFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (path.replace(/\/$/, '') === UI) return [];
		if (statSync(path).isDirectory()) return svelteFiles(path);
		return name.endsWith('.svelte') ? [path] : [];
	});
}

const files = svelteFiles(SRC).map((path) => ({
	path: relative(SRC, path),
	source: readFileSync(path, 'utf8')
}));
const WRAPPED = /<LoadingState\s+id="([^"]+)"\s*>[\s\S]*?<\/LoadingState\s*>/g;

describe('loading-state registry', () => {
	it('every Skeleton sits inside a LoadingState', () => {
		const offenders = files
			.filter(({ source }) => source.replace(WRAPPED, '').includes('<Skeleton'))
			.map(({ path }) => path);
		expect(offenders, 'wrap these in <LoadingState id="…"> and register the id').toEqual([]);
	});

	it('every LoadingState id is registered, and every registered id is used', () => {
		const used = new Set(
			files.flatMap(({ source }) => [...source.matchAll(WRAPPED)].map((m) => m[1]))
		);
		const registered = new Set(Object.keys(LOADING_STATES));
		expect([...used].filter((id) => !registered.has(id))).toEqual([]);
		expect([...registered].filter((id) => !used.has(id))).toEqual([]);
	});
});
