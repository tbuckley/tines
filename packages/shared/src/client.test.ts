import { describe, expect, it, vi } from 'vitest';
import { ApiError, ApiNetworkError, createApiClient } from './client.js';

/** undici's shape: a bare `TypeError: fetch failed` carrying the real cause. */
function fetchFailed(cause?: unknown): TypeError {
	return new TypeError('fetch failed', { cause });
}

/** A fetch that never connects. */
const failingFetch = (err: unknown) =>
	(async () => {
		throw err;
	}) as unknown as typeof globalThis.fetch;

/** A fetch that answers every request with the given status and JSON body. */
const respondingFetch = (status: number, body: unknown) =>
	(async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		})) as unknown as typeof globalThis.fetch;

describe('ApiNetworkError', () => {
	it('names the base URL, the request, and the runtime error code', async () => {
		const client = createApiClient({
			baseUrl: 'http://localhost:5173',
			fetch: failingFetch(
				fetchFailed(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))
			)
		});

		const err = await client.getTime().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiNetworkError);
		const net = err as ApiNetworkError;
		expect(net.message).toBe('GET /api/time: could not reach http://localhost:5173 (ECONNREFUSED)');
		expect(net.name).toBe('ApiNetworkError');
		expect(net.method).toBe('GET');
		expect(net.path).toBe('/api/time');
		expect(net.baseUrl).toBe('http://localhost:5173');
		expect(net.url).toBe('http://localhost:5173/api/time');
		expect(net.code).toBe('ECONNREFUSED');
	});

	it('keeps the original error as `cause`', async () => {
		const original = fetchFailed(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }));
		const client = createApiClient({ baseUrl: 'http://x', fetch: failingFetch(original) });
		const err = (await client.getTime().catch((e: unknown) => e)) as ApiNetworkError;
		expect(err.cause).toBe(original);
	});

	it('reads a code out of an AggregateError (the dual-stack DNS shape)', async () => {
		const aggregate = new AggregateError(
			[Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' })],
			'all attempts failed'
		);
		const client = createApiClient({
			baseUrl: 'https://tines.example',
			fetch: failingFetch(fetchFailed(aggregate))
		});
		const err = (await client.getTime().catch((e: unknown) => e)) as ApiNetworkError;
		expect(err.code).toBe('ENOTFOUND');
		expect(err.message).toBe('GET /api/time: could not reach https://tines.example (ENOTFOUND)');
	});

	it("falls back to the thrown error's message when there is no code", async () => {
		const client = createApiClient({
			baseUrl: 'http://localhost:5173',
			fetch: failingFetch(fetchFailed())
		});
		const err = (await client.getTime().catch((e: unknown) => e)) as ApiNetworkError;
		expect(err.code).toBeUndefined();
		expect(err.message).toBe('GET /api/time: could not reach http://localhost:5173 (fetch failed)');
	});

	it('describes a same-origin client rather than printing an empty URL', async () => {
		// The web app builds its client with `baseUrl: ''`.
		const client = createApiClient({ baseUrl: '', fetch: failingFetch(fetchFailed()) });
		const err = (await client.getTime().catch((e: unknown) => e)) as ApiNetworkError;
		expect(err.message).toBe('GET /api/time: could not reach the server (fetch failed)');
		expect(err.url).toBe('/api/time');
	});

	it('reports the path a list command actually requested, query string included', async () => {
		const client = createApiClient({
			baseUrl: 'http://localhost:5173/',
			fetch: failingFetch(fetchFailed())
		});
		const err = (await client
			.listProjects({ limit: 1 })
			.catch((e: unknown) => e)) as ApiNetworkError;
		expect(err.path).toBe('/api/v1/projects?limit=1');
		// The trailing slash is stripped by the client, so the URL is usable.
		expect(err.url).toBe('http://localhost:5173/api/v1/projects?limit=1');
	});

	it('covers the raw (non-JSON) path too', async () => {
		const client = createApiClient({
			baseUrl: 'http://localhost:5173',
			fetch: failingFetch(fetchFailed(Object.assign(new Error('reset'), { code: 'ECONNRESET' })))
		});
		const err = (await client
			.getArtifactContent('iss_1', 'design-doc')
			.catch((e: unknown) => e)) as ApiNetworkError;
		expect(err).toBeInstanceOf(ApiNetworkError);
		expect(err.method).toBe('GET');
		expect(err.path).toBe('/api/v1/issues/iss_1/artifacts/design-doc/content');
		expect(err.code).toBe('ECONNRESET');
	});

	it('records the method of a write', async () => {
		const client = createApiClient({ baseUrl: 'http://h', fetch: failingFetch(fetchFailed()) });
		const err = (await client
			.createProject({ name: 'P' })
			.catch((e: unknown) => e)) as ApiNetworkError;
		expect(err.method).toBe('POST');
		expect(err.message).toBe('POST /api/v1/projects: could not reach http://h (fetch failed)');
	});

	it('leaves a server response alone: a non-2xx is still an ApiError', async () => {
		const client = createApiClient({
			baseUrl: 'http://localhost:5173',
			fetch: respondingFetch(404, { error: { code: 'not_found', message: 'no such issue' } })
		});
		const err = await client.getTime().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err).not.toBeInstanceOf(ApiNetworkError);
		expect((err as ApiError).code).toBe('not_found');
	});

	it('leaves a successful response alone', async () => {
		const client = createApiClient({
			baseUrl: 'http://localhost:5173',
			fetch: respondingFetch(200, { time: '2026-01-01T00:00:00.000Z', unix: 1767225600000 })
		});
		expect((await client.getTime()).unix).toBe(1767225600000);
	});
});

describe('createIssueWithFiles', () => {
	it('sends indexed multipart parts, authoritative filenames, auth, and no manual boundary', async () => {
		let captured: RequestInit | undefined;
		const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			captured = init;
			return new Response(JSON.stringify({ id: 'iss_1' }), {
				status: 201,
				headers: { 'content-type': 'application/json' }
			});
		}) as typeof globalThis.fetch;
		const client = createApiClient({ baseUrl: 'https://example.test', apiKey: 'secret', fetch });
		await client.createIssueWithFiles('prj_1', { title: 'With file' }, [
			{
				name: 'screen',
				filename: 'Screenshot.png',
				file: new Blob([new Uint8Array([1, 2])], { type: 'image/png' })
			}
		]);
		expect(captured?.method).toBe('POST');
		expect(captured?.headers).toEqual({ authorization: 'Bearer secret' });
		const form = captured?.body as FormData;
		expect(JSON.parse(form.get('metadata') as string)).toEqual({
			issue: { title: 'With file' },
			attachments: [{ part: 'file-0', name: 'screen', filename: 'Screenshot.png' }]
		});
		const file = form.get('file-0') as File;
		expect(file.name).toBe('Screenshot.png');
		expect(file.type).toBe('image/png');
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
	});

	it('keeps ordinary issue creation as JSON', async () => {
		let captured: RequestInit | undefined;
		const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			captured = init;
			return new Response(JSON.stringify({ id: 'iss_1' }), { status: 201 });
		}) as typeof globalThis.fetch;
		await createApiClient({ baseUrl: '', fetch }).createIssue('prj_1', { title: 'Plain' });
		expect(captured?.headers).toEqual({
			accept: 'application/json',
			'content-type': 'application/json'
		});
		expect(captured?.body).toBe(JSON.stringify({ title: 'Plain' }));
	});
});

describe('getVersion', () => {
	it('calls the public unversioned endpoint without requiring an API key', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ version: '0.0.1234', commit: 'a'.repeat(40) }), {
					headers: { 'content-type': 'application/json' }
				})
		) as unknown as typeof globalThis.fetch;
		const client = createApiClient({ baseUrl: 'https://tines.example', fetch });
		expect(await client.getVersion()).toEqual({ version: '0.0.1234', commit: 'a'.repeat(40) });
		expect(fetch).toHaveBeenCalledWith(
			'https://tines.example/api/version',
			expect.objectContaining({ method: 'GET', headers: { accept: 'application/json' } })
		);
	});
});
