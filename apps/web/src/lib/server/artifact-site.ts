/**
 * Serving HTML artifacts as live pages (specs/artifacts/SPEC.md "Sites:
 * HTML artifacts"): the signed capability token in `/s/<token>/…`, the
 * headers every served byte carries, and path resolution inside a folder
 * version.
 *
 * Kit-free like crypto.ts, so the unit tests run without a request.
 */
import { ARTIFACT_SITE_INDEX } from '@tines/shared';

/** Payload of a site token: a specific version of a specific artifact, for one user. */
export interface SiteTokenPayload {
	/** Owner (artifact rows are user-scoped). */
	u: string;
	/** context_item id of the artifact. */
	a: string;
	/** artifact_version id — the link is a snapshot, "current" resolves at mint time. */
	v: string;
	/** Expiry, epoch ms. */
	e: number;
}

const TOKEN_VERSION = 'v1';
/** Domain separation: the same secret encrypts stored credentials elsewhere. */
const KEY_PREFIX = 'tines:artifact-site:v1:';

function toBase64Url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
	const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/**
 * HMAC key material. `SECRET_ENCRYPTION_KEY` is the production secret;
 * falling back to `BETTER_AUTH_SECRET` is what makes local dev and e2e work
 * without a new binding. Null when neither is set (the mint endpoint 503s).
 */
export function siteKeyMaterial(env: {
	SECRET_ENCRYPTION_KEY?: string;
	BETTER_AUTH_SECRET?: string;
}): string | null {
	return env.SECRET_ENCRYPTION_KEY || env.BETTER_AUTH_SECRET || null;
}

async function hmacKey(keyMaterial: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(KEY_PREFIX + keyMaterial)
	);
	return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
}

export async function mintSiteToken(
	payload: SiteTokenPayload,
	keyMaterial: string
): Promise<string> {
	const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
	const signed = `${TOKEN_VERSION}.${body}`;
	const sig = await crypto.subtle.sign(
		'HMAC',
		await hmacKey(keyMaterial),
		new TextEncoder().encode(signed)
	);
	return `${signed}.${toBase64Url(new Uint8Array(sig))}`;
}

export type SiteTokenResult =
	| { ok: true; payload: SiteTokenPayload }
	| { ok: false; reason: 'invalid' | 'expired' };

/** Verifies signature (constant time via `crypto.subtle.verify`) then expiry. */
export async function verifySiteToken(
	token: string,
	keyMaterial: string,
	now = Date.now()
): Promise<SiteTokenResult> {
	const parts = token.split('.');
	if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false, reason: 'invalid' };
	let valid = false;
	let payload: SiteTokenPayload;
	try {
		valid = await crypto.subtle.verify(
			'HMAC',
			await hmacKey(keyMaterial),
			fromBase64Url(parts[2]).buffer as ArrayBuffer,
			new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
		);
		payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1])));
	} catch {
		return { ok: false, reason: 'invalid' };
	}
	if (!valid) return { ok: false, reason: 'invalid' };
	if (typeof payload?.u !== 'string' || typeof payload?.a !== 'string')
		return { ok: false, reason: 'invalid' };
	if (typeof payload.e !== 'number' || payload.e <= now) return { ok: false, reason: 'expired' };
	return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// Response headers

export interface SiteHeaderOpts {
	/** Origin the bytes are served from (`url.origin` of the request). */
	servedOrigin: string;
	/** The token, so the CSP can pin sources to this artifact's own prefix. */
	token: string;
	/** App origin allowed to frame the page; `'self'` when app and sandbox coincide. */
	appOrigin: string;
	/**
	 * True unless the request landed on the configured sandbox origin: adds the
	 * CSP `sandbox` directive, which gives the document an opaque origin (so it
	 * can never be same-origin with the app, whatever the configuration).
	 */
	sandboxed: boolean;
	contentType: string;
	filename: string;
}

/**
 * Headers for one served byte range. Every source is pinned to the literal
 * `<origin>/s/<token>/` path prefix rather than `'self'`, so even in
 * same-origin mode the page cannot reach `/api/…`.
 */
export function siteHeaders(opts: SiteHeaderOpts): Record<string, string> {
	const prefix = `${opts.servedOrigin}/s/${opts.token}/`;
	const contentType =
		opts.contentType.startsWith('text/') && !opts.contentType.includes('charset=')
			? `${opts.contentType}; charset=utf-8`
			: opts.contentType;
	const csp = [
		`default-src 'none'`,
		`script-src 'unsafe-inline' 'unsafe-eval' blob: ${prefix}`,
		`style-src 'unsafe-inline' ${prefix}`,
		`img-src data: blob: ${prefix}`,
		`font-src data: ${prefix}`,
		`media-src data: blob: ${prefix}`,
		`connect-src ${prefix}`,
		`worker-src blob: ${prefix}`,
		`frame-src ${prefix}`,
		`form-action 'none'`,
		`base-uri 'none'`,
		`frame-ancestors ${opts.appOrigin}`
	];
	if (opts.sandboxed) csp.push('sandbox allow-scripts allow-forms allow-modals allow-popups');
	return {
		'content-type': contentType,
		'content-security-policy': csp.join('; '),
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer',
		'x-robots-tag': 'noindex, nofollow',
		'cache-control': 'private, max-age=300',
		'content-disposition': `inline; filename="${opts.filename}"`
	};
}

// ---------------------------------------------------------------------------
// Path resolution

export type SitePath =
	| { kind: 'file'; path: string }
	/** Path (relative to `/s/<token>/`) the request should be redirected to. */
	| { kind: 'redirect'; to: string }
	| { kind: 'missing' };

/**
 * Maps the `/s/<token>/<path…>` remainder onto a file of the version.
 * `entry` is `siteEntry()`'s answer: `''` for a single-file site (only the
 * root is servable), `index.html` for a folder.
 */
export function resolveSitePath(
	entry: string,
	files: { path: string }[],
	requested: string
): SitePath {
	const raw = requested.replace(/^\/+/, '');
	// `..` cannot escape anything (paths are matched exactly against the
	// version's list) but normalising keeps the 404 honest.
	const path = raw.split('/').filter((seg) => seg !== '' && seg !== '.' && seg !== '..');
	const joined = path.join('/');
	if (entry !== ARTIFACT_SITE_INDEX) {
		// Single-file site: the document is the root, nothing else exists.
		return joined === '' ? { kind: 'file', path: '' } : { kind: 'missing' };
	}
	const has = (p: string) => files.some((f) => f.path === p);
	if (joined === '') return has(entry) ? { kind: 'file', path: entry } : { kind: 'missing' };
	if (has(joined)) return { kind: 'file', path: joined };
	// A directory: redirect to the trailing slash so relative URLs inside its
	// index.html resolve against the directory, not its parent.
	const index = `${joined}/${ARTIFACT_SITE_INDEX}`;
	if (has(index)) {
		return requested.endsWith('/')
			? { kind: 'file', path: index }
			: { kind: 'redirect', to: `${joined}/` };
	}
	return { kind: 'missing' };
}

// ---------------------------------------------------------------------------
// Error pages (this URL is opened by humans in tabs, so: HTML, not JSON)

const SITE_ERRORS: Record<number, { title: string; body: string }> = {
	403: {
		title: 'Preview link expired',
		body: 'This preview link has expired — reopen it from the issue to get a fresh one.'
	},
	404: { title: 'Not found', body: 'There is nothing to preview at this address.' }
};

export function siteErrorPage(status: 403 | 404): Response {
	const { title, body } = SITE_ERRORS[status];
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100dvh;color:#334155"><main style="padding:2rem;text-align:center;max-width:32rem"><h1 style="font-size:1.25rem;margin:0 0 .5rem">${title}</h1><p style="margin:0">${body}</p></main></body></html>`,
		{
			status,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; sandbox`,
				'cache-control': 'no-store',
				'x-robots-tag': 'noindex, nofollow'
			}
		}
	);
}
