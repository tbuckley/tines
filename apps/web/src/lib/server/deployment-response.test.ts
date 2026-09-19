import { describe, expect, it, vi } from 'vitest';
import {
	finalizeDeploymentResponse,
	handleDeploymentFetch,
	isApiPath
} from './deployment-response';

const identity = { version: 'dev', commit: '0123456789abcdef0123456789abcdef01234567' };

describe('deployment response boundary', () => {
	it('matches only the API root and descendants', () => {
		expect(isApiPath('/api')).toBe(true);
		expect(isApiPath('/api/time')).toBe(true);
		expect(isApiPath('/apiary')).toBe(false);
		expect(isApiPath('/issues')).toBe(false);
	});

	it.each([200, 401, 403, 404, 405, 500])(
		'decorates a %s response and overrides conflicts',
		(status) => {
			const response = finalizeDeploymentResponse(
				new Request('https://example.test/api/test'),
				new Response('body', {
					status,
					statusText: 'Kept',
					headers: { 'x-tines-version': 'wrong', location: '/kept', 'server-timing': 'db;dur=1' }
				}),
				identity
			);
			expect(response.status).toBe(status);
			expect(response.statusText).toBe('Kept');
			expect(response.headers.get('x-tines-version')).toBe(identity.version);
			expect(response.headers.get('x-tines-commit')).toBe(identity.commit);
			expect(response.headers.get('location')).toBe('/kept');
			expect(response.headers.get('server-timing')).toBe('db;dur=1');
		}
	);

	it('clones immutable redirects and is idempotent', () => {
		const request = new Request('https://example.test/api/test');
		const once = finalizeDeploymentResponse(
			request,
			Response.redirect('https://example.test/to'),
			identity
		);
		const twice = finalizeDeploymentResponse(request, once, identity);
		expect(twice.status).toBe(302);
		expect(twice.headers.get('location')).toBe('https://example.test/to');
		expect(twice.headers.get('x-tines-version')).toBe('dev');
	});

	it('preserves multiple Set-Cookie headers', () => {
		const headers = new Headers();
		headers.append('set-cookie', 'first=one; Path=/; HttpOnly');
		headers.append('set-cookie', 'second=two; Path=/; Secure');
		const response = finalizeDeploymentResponse(
			new Request('https://example.test/api/test'),
			new Response('body', { headers }),
			identity
		);
		expect(response.headers.getSetCookie()).toEqual([
			'first=one; Path=/; HttpOnly',
			'second=two; Path=/; Secure'
		]);
	});

	it.each([204, 205, 304])('keeps status %s bodyless', async (status) => {
		const response = finalizeDeploymentResponse(
			new Request('https://example.test/api/test'),
			new Response(null, { status }),
			identity
		);
		expect(response.status).toBe(status);
		expect(await response.text()).toBe('');
	});

	it('removes a body from HEAD without consuming ordinary streams', async () => {
		const head = finalizeDeploymentResponse(
			new Request('https://example.test/api/test', { method: 'HEAD' }),
			new Response('secret'),
			identity
		);
		expect(await head.text()).toBe('');

		const source = new Response('streamed');
		const result = finalizeDeploymentResponse(
			new Request('https://example.test/api/test'),
			source,
			identity
		);
		expect(result.body).toBe(source.body);
		expect(await result.text()).toBe('streamed');
	});

	it('returns non-API responses by identity', () => {
		const source = new Response('page');
		expect(
			finalizeDeploymentResponse(new Request('https://example.test/apiary'), source, identity)
		).toBe(source);
	});

	it('sanitizes thrown API failures and rethrows page failures', async () => {
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const failure = new Error('private detail');
		const api = await handleDeploymentFetch(
			new Request('https://example.test/api/test'),
			async () => {
				throw failure;
			},
			identity
		);
		expect(api.status).toBe(500);
		expect(api.headers.get('cache-control')).toBe('no-store');
		expect(api.headers.get('x-tines-commit')).toBe(identity.commit);
		expect(await api.text()).toBe('Internal Server Error');
		await expect(
			handleDeploymentFetch(
				new Request('https://example.test/issues'),
				async () => {
					throw failure;
				},
				identity
			)
		).rejects.toBe(failure);
		expect(errorLog).toHaveBeenCalledTimes(1);
		expect(errorLog).toHaveBeenCalledWith('API request failed', {
			code: 'api_request_failed'
		});
		errorLog.mockRestore();
	});
});
