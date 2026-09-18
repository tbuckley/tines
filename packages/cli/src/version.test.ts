import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cliVersion } from './version.js';

describe('cliVersion', () => {
	it('reads the package manifest — the number CI stamps at publish time', () => {
		const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		expect(cliVersion()).toBe(manifest.version);
		// The fallback is a real code path; it must never be what a build ships.
		expect(cliVersion()).not.toBe('0.0.0-unknown');
	});
});
