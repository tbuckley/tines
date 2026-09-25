import { sha256Hex } from '$lib/server/crypto';

/**
 * Preview-only sign-in (docs/preview-login.md): lets a script or an agent
 * holding PREVIEW_LOGIN_TOKEN sign in to a PR preview as one fixed test user,
 * without an email round trip. Three gates, all required:
 *
 * 1. The build: `__TINES_PREVIEW_LOGIN__` is compiled in only for
 *    TINES_BUILD_CHANNEL=preview and the e2e build (vite.config.ts), so a
 *    production bundle carries no working route at all.
 * 2. The worker: PREVIEW_LOGIN_TOKEN is a secret set on the preview worker
 *    only. Unset, the route 404s.
 * 3. The request: `Authorization: Bearer <token>` must match it.
 *
 * It signs in only as PREVIEW_LOGIN_USER, never as a user named by the
 * caller, so the token cannot reach anyone else's account in the preview DB.
 */
export const PREVIEW_LOGIN_USER = {
	email: 'preview-probe@tines.invalid',
	name: 'Preview Probe'
} as const;

/** Sessions minted here expire after an hour; mint a fresh one per run. */
export const PREVIEW_SESSION_TTL_MS = 60 * 60 * 1000;

/** Shorter than this and the token is refused outright, configured or not. */
export const MIN_TOKEN_LENGTH = 32;

/** The production app's host: refused even if a preview bundle ever lands there. */
const PRODUCTION_HOST = 'tines.tbuckley.dev';

export type PreviewLoginGate = {
	enabledInBuild: boolean;
	configuredToken: string | undefined;
	authorization: string | null;
	hostname: string;
};

/**
 * 'disabled' when this deployment has no preview login (answer 404, as if
 * the route did not exist); 'denied' when it does but the token is wrong.
 */
export async function checkPreviewLogin(
	gate: PreviewLoginGate
): Promise<'ok' | 'disabled' | 'denied'> {
	const configured = gate.configuredToken?.trim();
	if (!gate.enabledInBuild || !configured || configured.length < MIN_TOKEN_LENGTH) {
		return 'disabled';
	}
	if (gate.hostname === PRODUCTION_HOST) return 'disabled';
	const presented = /^Bearer\s+(\S+)\s*$/i.exec(gate.authorization ?? '')?.[1];
	if (!presented) return 'denied';
	// Compare digests, not the strings: equal-length hex, so the comparison
	// leaks nothing about how much of the token matched.
	const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(configured)]);
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0 ? 'ok' : 'denied';
}

/**
 * Better Auth's signed-cookie value: `<token>.<base64 HMAC-SHA256(token)>`
 * under the auth secret (what e2e/helpers.ts `signedSessionCookie` builds).
 */
export async function signSessionToken(token: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token));
	return `${token}.${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}
