import { describe, expect, it } from 'vitest';
import {
	mintSiteToken,
	resolveSitePath,
	siteErrorPage,
	siteHeaders,
	siteKeyMaterial,
	verifySiteToken,
	type SiteTokenPayload
} from './artifact-site';

const KEY = 'test-secret-material';
const payload = (over: Partial<SiteTokenPayload> = {}): SiteTokenPayload => ({
	u: 'usr_1',
	a: 'ctx_1',
	v: 'ver_1',
	e: Date.now() + 60_000,
	...over
});

describe('site tokens', () => {
	it('round-trips a payload', async () => {
		const p = payload();
		const result = await verifySiteToken(await mintSiteToken(p, KEY), KEY);
		expect(result).toEqual({ ok: true, payload: p });
	});

	it('rejects a tampered payload, a tampered signature and another key', async () => {
		const token = await mintSiteToken(payload(), KEY);
		const [v, body, sig] = token.split('.');
		const other = await mintSiteToken(payload({ a: 'ctx_2' }), KEY);
		expect(await verifySiteToken(`${v}.${other.split('.')[1]}.${sig}`, KEY)).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(await verifySiteToken(`${v}.${body}.${other.split('.')[2]}`, KEY)).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(await verifySiteToken(token, 'different-secret')).toEqual({
			ok: false,
			reason: 'invalid'
		});
	});

	it('rejects malformed tokens without throwing', async () => {
		for (const token of ['', 'nope', 'v1.abc', 'v2.abc.def', 'v1.!!!.###']) {
			expect(await verifySiteToken(token, KEY)).toEqual({ ok: false, reason: 'invalid' });
		}
	});

	it('reports expiry separately from invalidity', async () => {
		const token = await mintSiteToken(payload({ e: Date.now() - 1 }), KEY);
		expect(await verifySiteToken(token, KEY)).toEqual({ ok: false, reason: 'expired' });
		// Still valid just before its expiry.
		const soon = payload({ e: 10_000 });
		expect(await verifySiteToken(await mintSiteToken(soon, KEY), KEY, 9_999)).toEqual({
			ok: true,
			payload: soon
		});
	});

	it('prefers the encryption key but falls back to the auth secret', () => {
		expect(siteKeyMaterial({ SECRET_ENCRYPTION_KEY: 'a', BETTER_AUTH_SECRET: 'b' })).toBe('a');
		expect(siteKeyMaterial({ BETTER_AUTH_SECRET: 'b' })).toBe('b');
		expect(siteKeyMaterial({})).toBeNull();
	});
});

describe('siteHeaders', () => {
	const base = {
		servedOrigin: 'https://proto.example.workers.dev',
		token: 'v1.abc.def',
		appOrigin: 'https://tines.example.com',
		contentType: 'text/html',
		filename: 'proto.html'
	};

	it('pins every source to the artifact prefix and never uses self', () => {
		const csp = siteHeaders({ ...base, sandboxed: false })['content-security-policy'];
		const prefix = 'https://proto.example.workers.dev/s/v1.abc.def/';
		expect(csp).toContain(`connect-src ${prefix}`);
		expect(csp).toContain(`script-src 'unsafe-inline' 'unsafe-eval' blob: ${prefix}`);
		expect(csp).toContain(`default-src 'none'`);
		expect(csp).toContain('frame-ancestors https://tines.example.com');
		expect(csp).not.toContain(`'self'`);
	});

	it('adds the sandbox directive only in same-origin mode', () => {
		expect(siteHeaders({ ...base, sandboxed: false })['content-security-policy']).not.toContain(
			'sandbox'
		);
		expect(siteHeaders({ ...base, sandboxed: true })['content-security-policy']).toContain(
			'sandbox allow-scripts allow-forms allow-modals allow-popups'
		);
	});

	it('appends a charset to text types only, and serves inline', () => {
		const html = siteHeaders({ ...base, sandboxed: true });
		expect(html['content-type']).toBe('text/html; charset=utf-8');
		expect(html['content-disposition']).toBe('inline; filename="proto.html"');
		expect(html['referrer-policy']).toBe('no-referrer');
		expect(
			siteHeaders({ ...base, sandboxed: true, contentType: 'image/png' })['content-type']
		).toBe('image/png');
		expect(
			siteHeaders({ ...base, sandboxed: true, contentType: 'text/css; charset=utf-8' })[
				'content-type'
			]
		).toBe('text/css; charset=utf-8');
	});
});

describe('resolveSitePath', () => {
	const files = [
		{ path: 'index.html' },
		{ path: 'app.js' },
		{ path: 'assets/logo.png' },
		{ path: 'docs/index.html' }
	];

	it('serves a single-file site at the root only', () => {
		expect(resolveSitePath('', [], '')).toEqual({ kind: 'file', path: '' });
		expect(resolveSitePath('', [], '/')).toEqual({ kind: 'file', path: '' });
		expect(resolveSitePath('', [], 'app.js')).toEqual({ kind: 'missing' });
	});

	it('resolves the entry, siblings and nested files of a folder', () => {
		expect(resolveSitePath('index.html', files, '')).toEqual({ kind: 'file', path: 'index.html' });
		expect(resolveSitePath('index.html', files, 'app.js')).toEqual({ kind: 'file', path: 'app.js' });
		expect(resolveSitePath('index.html', files, 'assets/logo.png')).toEqual({
			kind: 'file',
			path: 'assets/logo.png'
		});
	});

	it('redirects a directory to its trailing slash, then serves its index', () => {
		expect(resolveSitePath('index.html', files, 'docs')).toEqual({
			kind: 'redirect',
			to: 'docs/'
		});
		expect(resolveSitePath('index.html', files, 'docs/')).toEqual({
			kind: 'file',
			path: 'docs/index.html'
		});
	});

	it('404s unknown paths and cannot be walked out of', () => {
		expect(resolveSitePath('index.html', files, 'missing.js')).toEqual({ kind: 'missing' });
		expect(resolveSitePath('index.html', files, '../../etc/passwd')).toEqual({ kind: 'missing' });
		// `..` segments are dropped rather than climbing, so a traversal
		// resolves to a path that is simply not in the version's file list.
		expect(resolveSitePath('index.html', files, 'assets/../index.html')).toEqual({
			kind: 'missing'
		});
	});
});

describe('siteErrorPage', () => {
	it('is a locked-down HTML page, not JSON', async () => {
		const res = siteErrorPage(403);
		expect(res.status).toBe(403);
		expect(res.headers.get('content-type')).toContain('text/html');
		expect(res.headers.get('content-security-policy')).toContain('sandbox');
		expect(await res.text()).toContain('expired');
		expect(await siteErrorPage(404).text()).toContain('Not found');
	});
});
