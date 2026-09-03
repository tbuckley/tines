/**
 * Builds the CLI twice from one entry:
 *
 *   dist/index.js   — the npm bin (ESM, `#!/usr/bin/env node`), what
 *                     `npm i -g tines` and the runner daemon's refresh use.
 *   dist/tines.cjs  — the single-file build the supervisor seeds into Gemini
 *                     sandboxes as an inline environment source (SPEC.md
 *                     "The CLI ships into every workspace"). CommonJS so a
 *                     bare `node /workspace/bin/tines.cjs` runs it with no
 *                     package.json beside it, the version stamped in since
 *                     there is no manifest to read, and guarded under the
 *                     provider's 1 MB per-file inline cap — a bundle that
 *                     outgrows it would fail every Gemini launch at once.
 *
 * Both are dependency-free: commander is bundled, node built-ins stay
 * external. Run by `pnpm build` (and by CI's publish workflow after it has
 * stamped the version into package.json).
 */
import { build } from 'esbuild';
import { readFileSync, statSync } from 'node:fs';

const INLINE_SOURCE_MAX_BYTES = 1024 * 1024;

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const common = {
	entryPoints: ['src/index.ts'],
	bundle: true,
	platform: 'node',
	target: 'node20',
	logLevel: 'info'
};

await build({
	...common,
	format: 'esm',
	banner: { js: '#!/usr/bin/env node' },
	outfile: 'dist/index.js'
});

await build({
	...common,
	format: 'cjs',
	outfile: 'dist/tines.cjs',
	define: { __TINES_VERSION__: JSON.stringify(manifest.version) },
	// version.ts reads ../package.json via import.meta.url on the ESM path;
	// the define above short-circuits that path here, so the CJS-empty
	// import.meta is never reached and the warning is noise.
	logOverride: { 'empty-import-meta': 'silent' }
});

const size = statSync('dist/tines.cjs').size;
if (size > INLINE_SOURCE_MAX_BYTES) {
	console.error(
		`dist/tines.cjs is ${size} bytes, over the ${INLINE_SOURCE_MAX_BYTES}-byte inline-source cap Gemini environments enforce; every Gemini launch would fail. Trim the bundle.`
	);
	process.exit(1);
}
