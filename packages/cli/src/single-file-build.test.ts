/**
 * The single-file build the supervisor seeds into Gemini sandboxes
 * (scripts/build.mjs → dist/tines.cjs): it must run as a bare CommonJS file
 * with no manifest beside it, report its stamped version, and stay under
 * the provider's 1 MB inline-source cap — over the cap, every Gemini launch
 * fails at once, which is why CI runs this on every pull request.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const INLINE_SOURCE_MAX_BYTES = 1024 * 1024;

describe('dist/tines.cjs', () => {
	let dir: string;
	let outfile: string;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'tines-cjs-'));
		outfile = join(dir, 'tines.cjs');
		await build({
			entryPoints: [new URL('./index.ts', import.meta.url).pathname],
			bundle: true,
			platform: 'node',
			target: 'node20',
			format: 'cjs',
			outfile,
			define: { __TINES_VERSION__: JSON.stringify('9.9.9-test') },
			logOverride: { 'empty-import-meta': 'silent' },
			logLevel: 'silent'
		});
	}, 60_000);

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('runs standalone and reports the stamped version', () => {
		const out = execFileSync(process.execPath, [outfile, '--version'], { encoding: 'utf8' });
		expect(out.trim()).toBe('9.9.9-test');
	});

	it('fits the 1 MB inline-source cap with headroom', () => {
		const size = statSync(outfile).size;
		expect(size).toBeLessThan(INLINE_SOURCE_MAX_BYTES * 0.75);
	});

	it('honours a TINES_CONFIG file saying the proxy injects auth', () => {
		const config = join(dir, 'tines.config.json');
		execFileSync(process.execPath, [
			'-e',
			`require('fs').writeFileSync(${JSON.stringify(config)}, JSON.stringify({ url: 'https://sandbox.example', auth: 'proxy' }))`
		]);
		const out = execFileSync(process.execPath, [outfile, 'config', '--json'], {
			encoding: 'utf8',
			env: { ...process.env, TINES_CONFIG: config, TINES_API_KEY: '', TINES_API_URL: '' }
		});
		expect(JSON.parse(out)).toMatchObject({
			url: { value: 'https://sandbox.example', source: 'config' },
			api_key: { value: null, source: 'proxy' },
			config_path: config
		});
	});
});
