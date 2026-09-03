/**
 * The published version, read from the package manifest rather than hardcoded.
 * CI stamps the patch number into that manifest at publish time (see
 * .github/workflows/publish-cli.yml), so a literal here would always lie —
 * and `tines --version` is how you tell an installed CLI apart from the repo.
 * `../package.json` resolves for both layouts: src/*.ts under tsx, and the
 * bundled dist/index.js in the published tarball.
 *
 * Its own module (not program.ts) so the daemon can stamp it into a run log
 * without importing the whole command tree.
 */
import { readFileSync } from 'node:fs';

/**
 * Stamped by the single-file build (scripts/build.mjs `define`): that
 * bundle is seeded into sandboxes on its own, with no manifest beside it.
 * Absent everywhere else — `typeof` keeps the reference from throwing.
 */
declare const __TINES_VERSION__: string | undefined;

export function cliVersion(): string {
	if (typeof __TINES_VERSION__ === 'string') return __TINES_VERSION__;
	try {
		const manifest = new URL('../package.json', import.meta.url);
		return JSON.parse(readFileSync(manifest, 'utf8')).version ?? '0.0.0-unknown';
	} catch {
		return '0.0.0-unknown';
	}
}
