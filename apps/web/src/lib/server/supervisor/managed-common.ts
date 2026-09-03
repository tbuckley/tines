/**
 * Plumbing every managed-runner adapter shares: the encryption-key guard,
 * the public Tines URL managed runs reach the API at, the self-API GET the
 * launch materials come from, and the stored GitHub PAT.
 *
 * Worker-imported (via the adapters): relative/package imports only, no
 * `$lib`.
 */
import type { Kysely } from 'kysely';
import { decryptSecret } from '../crypto';
import type { Database } from '../db';

export function requireEncryptionKey(env: Env): string {
	if (!env.SECRET_ENCRYPTION_KEY) {
		throw new Error(
			'SECRET_ENCRYPTION_KEY is not configured; cannot use stored provider credentials'
		);
	}
	return env.SECRET_ENCRYPTION_KEY;
}

/** The public base URL managed runs use to reach the Tines API. */
export function tinesApiBaseUrl(env: Env): string {
	const base = env.TINES_PUBLIC_URL ?? env.BETTER_AUTH_URL;
	if (!base) {
		throw new Error(
			'Cannot determine the public Tines URL (set TINES_PUBLIC_URL or BETTER_AUTH_URL); managed runs need it to reach the API'
		);
	}
	return base.replace(/\/+$/, '');
}

export function parseJson<T>(raw: string | null | undefined): T | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/**
 * GET against our own API with the run key (self-seeding's own mechanism).
 * Prefers the SELF service binding — it invokes this worker's fetch handler
 * in-process, which is the only way to reach ourselves in production: a
 * worker on a custom domain cannot `fetch()` its own hostname (Cloudflare
 * routes that to the nonexistent origin → 522). A thrown SELF call falls
 * back to plain fetch for dev setups where the binding doesn't resolve;
 * HTTP error statuses are real API answers and propagate. An injected
 * `fetchFn` (unit tests) bypasses the binding entirely.
 */
export function createSelfApi(env: Env, fetchFn?: typeof globalThis.fetch) {
	const plain = fetchFn ?? globalThis.fetch.bind(globalThis);
	return async function apiGet<T>(base: string, path: string, runKey: string): Promise<T> {
		const url = `${base}${path}`;
		const init = { headers: { authorization: `Bearer ${runKey}` } };
		let res: Response;
		if (fetchFn) {
			res = await fetchFn(url, init);
		} else if (env.SELF) {
			res = (await env.SELF.fetch(url, init).catch(() => plain(url, init))) as Response;
		} else {
			res = await plain(url, init);
		}
		if (!res.ok) throw new Error(`launch materials fetch failed: GET ${path} → ${res.status}`);
		return res.json() as Promise<T>;
	};
}

/** The stored GitHub PAT, decrypted; null when none is configured. */
export async function loadGithubPat(
	db: Kysely<Database>,
	env: Env,
	userId: string
): Promise<string | null> {
	const settings = await db
		.selectFrom('supervisor_settings')
		.select('github_pat_enc')
		.where('user_id', '=', userId)
		.executeTakeFirst();
	if (!settings?.github_pat_enc) return null;
	return decryptSecret(settings.github_pat_enc, requireEncryptionKey(env));
}
