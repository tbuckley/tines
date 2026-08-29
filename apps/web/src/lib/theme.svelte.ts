/**
 * Theme preference: `system` (default) follows the OS, `light`/`dark` override
 * it. The choice lives in localStorage only — the server never sees it, so
 * `src/app.html` carries a pre-paint copy of the same rule to avoid a flash.
 */
export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** localStorage key. Duplicated verbatim in `src/app.html`'s pre-paint script. */
export const THEME_STORAGE_KEY = 'tines:theme';
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** Unknown, missing, or corrupt values fall back to `system`. */
export function parsePreference(raw: string | null | undefined): ThemePreference {
	return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
	if (pref === 'system') return systemPrefersDark ? 'dark' : 'light';
	return pref;
}

let preference = $state<ThemePreference>('system');
let systemPrefersDark = $state(false);

/** Storage throws in Safari private mode and when cookies are blocked. */
function readStored(): ThemePreference {
	try {
		return parsePreference(localStorage.getItem(THEME_STORAGE_KEY));
	} catch {
		return 'system';
	}
}

function writeStored(pref: ThemePreference): void {
	try {
		localStorage.setItem(THEME_STORAGE_KEY, pref);
	} catch {
		// Unpersisted, but the theme still applies for this session.
	}
}

export const theme = {
	get preference(): ThemePreference {
		return preference;
	},
	get resolved(): ResolvedTheme {
		return resolveTheme(preference, systemPrefersDark);
	},
	/** `setItem` doesn't fire `storage` in the same tab, so this can't echo back. */
	set(pref: ThemePreference): void {
		preference = pref;
		writeStored(pref);
	},
	/** Call once in the browser (root layout `onMount`); returns a teardown. */
	init(): () => void {
		if (typeof window === 'undefined') return () => {};

		preference = readStored();

		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		systemPrefersDark = mq.matches;
		const onSystemChange = (event: MediaQueryListEvent) => {
			systemPrefersDark = event.matches;
		};
		mq.addEventListener('change', onSystemChange);

		// Keep tabs in step when the preference changes in another one.
		const onStorage = (event: StorageEvent) => {
			if (event.key === THEME_STORAGE_KEY) preference = parsePreference(event.newValue);
		};
		window.addEventListener('storage', onStorage);

		// The pre-paint script already set the class, so the first run is a no-op.
		const stopEffects = $effect.root(() => {
			$effect(() => {
				document.documentElement.classList.toggle('dark', theme.resolved === 'dark');
			});
		});

		return () => {
			mq.removeEventListener('change', onSystemChange);
			window.removeEventListener('storage', onStorage);
			stopEffects();
		};
	}
};
