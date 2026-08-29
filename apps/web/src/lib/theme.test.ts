import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	parsePreference,
	resolveTheme,
	THEME_PREFERENCES,
	THEME_STORAGE_KEY,
	type ThemePreference
} from './theme.svelte';

describe('parsePreference', () => {
	it('round-trips every known preference', () => {
		for (const pref of THEME_PREFERENCES) expect(parsePreference(pref)).toBe(pref);
	});

	it.each([null, undefined, '', 'DARK', 'blue', ' dark'])(
		'falls back to system for %o',
		(raw) => {
			expect(parsePreference(raw)).toBe('system');
		}
	);
});

describe('resolveTheme', () => {
	const cases: [ThemePreference, boolean, string][] = [
		['system', false, 'light'],
		['system', true, 'dark'],
		['light', false, 'light'],
		['light', true, 'light'],
		['dark', false, 'dark'],
		['dark', true, 'dark']
	];

	it.each(cases)('%s with systemPrefersDark=%s resolves to %s', (pref, systemDark, expected) => {
		expect(resolveTheme(pref, systemDark)).toBe(expected);
	});
});

// The pre-paint script in app.html duplicates the key and the resolution rule
// because the server can't read localStorage. Guard against silent drift.
describe('app.html pre-paint script', () => {
	const html = readFileSync(new URL('../app.html', import.meta.url), 'utf8');

	it('reads the same storage key', () => {
		expect(html).toContain(`'${THEME_STORAGE_KEY}'`);
	});

	it('falls back to the system preference', () => {
		expect(html).toContain('prefers-color-scheme: dark');
	});
});
