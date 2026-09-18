import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Tines/122: `pnpm cli` must always target the local dev server. The old
// `TINES_API_URL=${TINES_API_URL:-…}` default let an ambient TINES_API_URL — production, in every
// agent run — silently win, so `pnpm cli` talked to the live deployment while looking local.
describe('start script', () => {
	it('pins TINES_API_URL to localhost and performs no shell expansion', () => {
		const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		const start: string = manifest.scripts.start;
		expect(start.startsWith('TINES_API_URL=http://localhost:5173 ')).toBe(true);
		expect(start).not.toContain('$');
	});
});
