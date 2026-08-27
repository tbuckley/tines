/**
 * Kit-free hashing and secret encryption shared by the API layer (core.ts)
 * and the worker-imported supervisor engine — the engine's import chain must
 * not reach `@sveltejs/kit`, so this cannot live in api/core.ts.
 */
export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Secret encryption at rest (SPEC.md "Credentials for source access"):
// AES-256-GCM under a server-held Workers secret (SECRET_ENCRYPTION_KEY),
// so a leaked D1 dump alone cannot recover a provider API key or the GitHub
// PAT. Ciphertexts are versioned ("v1:") so the scheme — or the key — can
// rotate later without a breaking migration.

const SECRET_VERSION = 'v1';

/** Derives the AES-GCM key from the binding's string material. */
async function aesKey(keyMaterial: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyMaterial));
	return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function toBase64(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/** Encrypts a secret for storage: `v1:<base64 iv>:<base64 ciphertext>`, fresh IV per call. */
export async function encryptSecret(plaintext: string, keyMaterial: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await aesKey(keyMaterial);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		new TextEncoder().encode(plaintext)
	);
	return `${SECRET_VERSION}:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

/** Decrypts a stored secret. Throws on an unknown version or a bad key/ciphertext. */
export async function decryptSecret(stored: string, keyMaterial: string): Promise<string> {
	const [version, ivB64, dataB64] = stored.split(':');
	if (version !== SECRET_VERSION || !ivB64 || !dataB64) {
		throw new Error(`Unreadable stored secret (expected "${SECRET_VERSION}:<iv>:<data>")`);
	}
	const key = await aesKey(keyMaterial);
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: fromBase64(ivB64) as BufferSource },
		key,
		fromBase64(dataB64) as BufferSource
	);
	return new TextDecoder().decode(plaintext);
}

/**
 * The display hint stored alongside a write-only secret: never the value,
 * just enough shape to recognize it ("github_pat_…cdef"). Short secrets
 * degrade to the ellipsis alone rather than leaking most of the value.
 */
export function secretHint(secret: string): string {
	const prefix = secret.length >= 12 ? secret.slice(0, Math.min(8, secret.length - 8)) : '';
	const suffix = secret.length >= 12 ? secret.slice(-4) : '';
	return `${prefix}…${suffix}`;
}
