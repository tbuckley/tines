import { describe, expect, it, vi } from 'vitest';

const getSession = vi.fn(async () => null);
vi.mock('$lib/server/auth', () => ({
	getAuth: () => ({ api: { getSession } })
}));
vi.mock('better-auth/svelte-kit', () => ({
	svelteKitHandler: async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => Response }) =>
		resolve(event)
}));

const { handle } = await import('./hooks.server');

function request(pathname: string, headers: Record<string, string> = {}) {
	const url = new URL(`https://tines.test${pathname}`);
	return {
		url,
		locals: {} as Record<string, unknown>,
		platform: { env: {} as Env },
		request: new Request(url, { headers })
	};
}

async function run(event: ReturnType<typeof request>) {
	getSession.mockClear();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (await (handle as any)({ event, resolve: async () => new Response('ok') })) as Response;
}

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

	it('still resolves the session for page navigations', async () => {
		await run(request('/issues', { authorization: 'Bearer tk_abc' }));
		expect(getSession).toHaveBeenCalledOnce();
	});

	it('reports server timing', async () => {
		const response = await run(request('/issues'));
		expect(response.headers.get('Server-Timing')).toMatch(/auth;dur=[\d.]+, app;dur=[\d.]+/);
	});
});
