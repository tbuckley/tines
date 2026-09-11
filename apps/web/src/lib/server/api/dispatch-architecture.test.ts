import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function filesBelow(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? filesBelow(path) : [path];
	});
}

describe('dispatch trigger ownership', () => {
	it('keeps scheduling out of API route handlers and issue transfer', () => {
		const routes = new URL('../../../routes/api/v1', import.meta.url).pathname;
		const sources = filesBelow(routes)
			.filter((path) => path.endsWith('+server.ts'))
			.map((path) => `${path}\n${readFileSync(path, 'utf8')}`)
			.concat(readFileSync(new URL('./issue-transfer.ts', import.meta.url), 'utf8'))
			.join('\n');
		expect(sources).not.toMatch(/supervisor\/engine/);
		expect(sources).not.toMatch(/\b(?:queue|run)DispatchPass\b/);
	});
});
