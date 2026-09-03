/**
 * The single-file CLI build the supervisor seeds into Gemini sandboxes
 * (SPEC.md "The CLI ships into every workspace"): `dist/tines.cjs` from the
 * published `tines` package, fetched from the npm CDN at launch and cached
 * per isolate.
 *
 * Fetched rather than bundled into the worker for the same reason the local
 * daemon installs `tines@latest` before each launch: merging to `main`
 * deploys the worker and publishes the CLI in one push, so the newest
 * published build is what matches the prompts this deployment writes — and
 * the worker build stays independent of the CLI build. The cost is one
 * ~300 KB fetch per isolate per ten minutes; the failure mode is a launch
 * failure (runner backoff, never a strike), with the URL in the error.
 *
 * Worker-imported (via the Gemini adapter): relative/package imports only.
 */
import { GEMINI_INLINE_SOURCE_MAX_BYTES } from '@tines/shared';

export const DEFAULT_CLI_BUNDLE_URL = 'https://cdn.jsdelivr.net/npm/tines@latest/dist/tines.cjs';

/** How long a fetched bundle is reused before the CDN is asked again. */
export const CLI_BUNDLE_CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedBundle {
	url: string;
	text: string;
	fetchedAt: number;
}

let cache: CachedBundle | null = null;

/** Test hook: forget the cached bundle. */
export function resetCliBundleCache(): void {
	cache = null;
}

export function cliBundleUrl(env: Env): string {
	return env.TINES_CLI_BUNDLE_URL || DEFAULT_CLI_BUNDLE_URL;
}

/**
 * The bundle's text, from cache or the CDN. Throws (a launch failure) when
 * the fetch fails or the file would not fit the provider's inline cap —
 * a bundle over the cap fails every Gemini launch, which the CLI build
 * itself guards against (packages/cli/scripts/build.mjs).
 */
export async function loadCliBundle(
	env: Env,
	fetchFn: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
	now: number = Date.now()
): Promise<string> {
	const url = cliBundleUrl(env);
	if (cache && cache.url === url && now - cache.fetchedAt < CLI_BUNDLE_CACHE_TTL_MS) {
		return cache.text;
	}
	let res: Response;
	try {
		res = await fetchFn(url);
	} catch (e) {
		throw new Error(
			`could not fetch the tines CLI bundle from ${url}: ${e instanceof Error ? e.message : String(e)}`
		);
	}
	if (!res.ok) {
		throw new Error(
			`fetching the tines CLI bundle from ${url} returned ${res.status}${res.status === 404 ? ' — has a build carrying dist/tines.cjs been published yet?' : ''}`
		);
	}
	const text = await res.text();
	const bytes = new TextEncoder().encode(text).length;
	if (bytes > GEMINI_INLINE_SOURCE_MAX_BYTES) {
		throw new Error(
			`the tines CLI bundle at ${url} is ${bytes} bytes, over the ${GEMINI_INLINE_SOURCE_MAX_BYTES}-byte inline-source cap Gemini environments enforce`
		);
	}
	if (bytes === 0) throw new Error(`the tines CLI bundle at ${url} is empty`);
	cache = { url, text, fetchedAt: now };
	return text;
}
