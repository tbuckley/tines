/**
 * Kit-free hashing shared by the API layer (core.ts) and the worker-imported
 * supervisor engine — the engine's import chain must not reach
 * `@sveltejs/kit`, so this cannot live in api/core.ts.
 */
export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
