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

	it('still resolves the session when a bearer key rides alongside cookies', async () => {
		// requireActor() prefers the session over the key; skipping here would
		// flip that precedence for requests carrying both credentials.
		await run(
			request('/api/v1/projects', {
				authorization: 'Bearer tk_abc',
				cookie: 'better-auth.session_token=x'
			})
		);
		expect(getSession).toHaveBeenCalledOnce();
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
});
