import { describe, expect, it, vi } from 'vitest';

const getSession = vi.fn(async () => null);
vi.mock('$lib/server/auth', () => ({
	getAuth: () => ({ api: { getSession } })
}));
vi.mock('better-auth/svelte-kit', () => ({
	svelteKitHandler: async ({
		event,
		resolve
	}: {
		event: unknown;
		resolve: (e: unknown) => Response;
	}) => resolve(event)
}));

const { handle } = await import('./hooks.server');

function request(pathname: string, headers: Record<string, string> = {}, method = 'GET') {
	const url = new URL(`https://tines.test${pathname}`);
	return {
		url,
		locals: {} as Record<string, unknown>,
		platform: { env: {} as Env },
		request: new Request(url, { headers, method })
	};
}

async function run(event: ReturnType<typeof request>, resolved = new Response('ok')) {
	getSession.mockClear();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (await (handle as any)({ event, resolve: async () => resolved })) as Response;
}

/** What SvelteKit returns itself for an unsupported verb on a real route. */
const kit405 = () =>
	new Response('PUT method not allowed', { status: 405, headers: { allow: 'GET, POST, HEAD' } });

describe('handle', () => {
	it('skips the session lookup for bearer-authenticated API requests', async () => {
		const event = request('/api/v1/projects', { authorization: 'Bearer tk_abc' });
		await run(event);
		expect(getSession).not.toHaveBeenCalled();
		expect(event.locals.user).toBeNull();
		expect(event.locals.session).toBeNull();
	});

	it('still resolves the session for cookie-authenticated API requests', async () => {
		await run(request('/api/v1/projects', { cookie: 'better-auth.session_token=x' }));
		expect(getSession).toHaveBeenCalledOnce();
	});

	it('uses bearer authority when a key rides alongside cookies', async () => {
		await run(
			request('/api/v1/projects', {
				authorization: 'Bearer tk_abc',
				cookie: 'better-auth.session_token=x'
			})
		);
		expect(getSession).not.toHaveBeenCalled();
	});

	it('still resolves the session for a Bearer header with no key', async () => {
		// requireActor() would reject 'Bearer' with nothing after it and the
		// session used to win; an empty header must not take the fast path.
		await run(request('/api/v1/projects', { authorization: 'Bearer ' }));
		expect(getSession).toHaveBeenCalledOnce();
	});

	it('still resolves the session for page navigations', async () => {
		await run(request('/issues', { authorization: 'Bearer tk_abc' }));
		expect(getSession).toHaveBeenCalledOnce();
	});

	it('answers a wrong-verb API request with the error envelope', async () => {
		// Kit's own 405 never reaches a handler, so the hook is the only place
		// that can put it in the documented shape (Tines/83).
		const response = await run(
			request('/api/v1/projects', { authorization: 'Bearer tk_abc' }, 'PUT'),
			kit405()
		);
		expect(response.status).toBe(405);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get('allow')).toBe('GET, POST, HEAD');
		expect(await response.json()).toEqual({
			error: { code: 'method_not_allowed', message: 'PUT is not allowed on this resource' }
		});
	});

	it('still reports server timing on a rewritten 405', async () => {
		const response = await run(request('/api/v1/projects', {}, 'PUT'), kit405());
		expect(response.headers.get('Server-Timing')).toMatch(/auth;dur=[\d.]+, app;dur=[\d.]+/);
	});

	it('leaves a page 405 as Kit wrote it', async () => {
		const response = await run(request('/issues', {}, 'PUT'), kit405());
		expect(response.status).toBe(405);
		expect(await response.text()).toBe('PUT method not allowed');
	});

	it('reports server timing', async () => {
		const response = await run(request('/issues'));
		expect(response.headers.get('Server-Timing')).toMatch(/auth;dur=[\d.]+, app;dur=[\d.]+/);
	});

	it.each(['/api/time', '/api/auth/get-session', '/api/unknown'])(
		'decorates %s with the server build identity',
		async (path) => {
			const response = await run(request(path));
			expect(response.headers.get('x-tines-version')).toBe('dev');
			expect(response.headers.get('x-tines-commit')).toMatch(/^(?:[0-9a-f]{40}|unknown)$/);
		}
	);

	it('does not decorate non-API pages', async () => {
		const response = await run(request('/issues'));
		expect(response.headers.has('x-tines-version')).toBe(false);
		expect(response.headers.has('x-tines-commit')).toBe(false);
	});
});

describe('artifact sandbox hostname boundary', () => {
	const origin = 'https://proto.example.workers.dev';
	function sandboxRequest(path: string, configured = origin) {
		const event = request(path, { cookie: 'better-auth.session_token=app-cookie' });
		event.url = new URL(path, origin);
		event.request = new Request(event.url, { headers: event.request.headers });
		event.platform.env.ARTIFACT_SANDBOX_ORIGIN = configured;
		return event;
	}

	it.each(['/issues', '/api/v1/projects', '/api/auth/get-session', '/_app/entry.js', '/s'])(
		'rejects %s before routing or session lookup',
		async (path) => {
			const response = await run(sandboxRequest(path));
			expect(response.status).toBe(404);
			expect(await response.text()).toBe('Not found');
			expect(getSession).not.toHaveBeenCalled();
			if (path.startsWith('/api/')) {
				expect(response.headers.get('x-tines-version')).toBe('dev');
			}
		}
	);

	it.each([origin, `${origin}/`, 'https://PROTO.example.workers.dev:443/'])(
		'routes only site bytes without an app session with config %s',
		async (configured) => {
			const event = sandboxRequest('/s/token/index.html', configured);
			const resolved = new Response('artifact bytes');
			expect(await run(event, resolved)).toBe(resolved);
			expect(getSession).not.toHaveBeenCalled();
			expect(event.locals.user).toBeNull();
			expect(event.locals.session).toBeNull();
			expect((await run(sandboxRequest('/issues', configured))).status).toBe(404);
		}
	);

	it.each([
		'not a URL',
		'javascript:alert(1)',
		`${origin}/path`,
		`${origin}?q=1`,
		`${origin}#x`,
		'https://user:pass@proto.example.workers.dev'
	])('ignores invalid origin config %s', async (configured) => {
		expect((await run(sandboxRequest('/issues', configured))).status).toBe(200);
		expect(getSession).toHaveBeenCalledOnce();
	});

	it('keeps the app host on the normal authenticated path', async () => {
		const event = request('/issues');
		event.platform.env.ARTIFACT_SANDBOX_ORIGIN = origin;
		expect((await run(event)).status).toBe(200);
		expect(getSession).toHaveBeenCalledOnce();
	});
});
