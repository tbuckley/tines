import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	finalizePublicationResponse,
	handlePublicationFetch,
	isPublicPublicationPath,
	preparePublicationRequest
} from './response';

describe('public publication response boundary', () => {
	it('is wired around the shipping Worker fetch entry', () => {
		const source = readFileSync(new URL('../../../../worker/index.ts', import.meta.url), 'utf8');
		expect(source).toMatch(/return handlePublicationFetch\(request, \(prepared\) =>/);
		expect(source).toContain('return worker.fetch(prepared, env, ctx)');
	});

	it('matches every public descendant without matching lookalike prefixes', () => {
		expect(isPublicPublicationPath('/p')).toBe(true);
		expect(isPublicPublicationPath('/p/id/unknown')).toBe(true);
		expect(isPublicPublicationPath('/api/v1/publications/public/id/__data.json')).toBe(true);
		expect(isPublicPublicationPath('/private')).toBe(false);
		expect(isPublicPublicationPath('/publication')).toBe(false);
		expect(isPublicPublicationPath('/api/v1/publications/publicity')).toBe(false);
	});

	it('replaces arbitrary policies and validators while preserving a framework nonce', async () => {
		const response = finalizePublicationResponse(
			new Request('https://example.test/p/id'),
			new Response('<h1>snapshot</h1>', {
				status: 404,
				headers: {
					'content-type': 'text/html; charset=utf-8',
					'content-security-policy': "script-src 'nonce-safe123' https://unsafe.test; img-src *",
					etag: 'private',
					'last-modified': 'yesterday'
				}
			})
		);

		expect(response.status).toBe(404);
		expect(await response.text()).toBe('<h1>snapshot</h1>');
		expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.has('etag')).toBe(false);
		expect(response.headers.has('last-modified')).toBe(false);
		const csp = response.headers.get('content-security-policy');
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'self' 'nonce-safe123'");
		expect(csp).toContain("form-action 'self'");
		expect(csp).not.toContain('unsafe.test');
	});

	it('uses the inert policy and a byte-free body for API HEAD responses', async () => {
		const response = finalizePublicationResponse(
			new Request('https://example.test/api/v1/publications/public/id/download', {
				method: 'HEAD'
			}),
			new Response('secret', { headers: { 'content-type': 'application/json' } })
		);
		expect(await response.text()).toBe('');
		expect(response.headers.get('content-security-policy')).toContain("script-src 'none'");
		expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
	});

	it('strips conditional validators before handling public requests only', () => {
		const publicRequest = preparePublicationRequest(
			new Request('https://example.test/p/id', {
				headers: {
					'if-none-match': 'private',
					'if-modified-since': 'yesterday',
					accept: 'text/html'
				}
			})
		);
		expect(publicRequest.headers.has('if-none-match')).toBe(false);
		expect(publicRequest.headers.has('if-modified-since')).toBe(false);
		expect(publicRequest.headers.get('accept')).toBe('text/html');

		const privateRequest = new Request('https://example.test/private', {
			headers: { 'if-none-match': 'private' }
		});
		expect(preparePublicationRequest(privateRequest)).toBe(privateRequest);
	});

	it('turns a bypassed 304 into a neutral non-cacheable failure', async () => {
		const response = finalizePublicationResponse(
			new Request('https://example.test/p/id'),
			new Response(null, { status: 304, headers: { etag: 'private' } })
		);
		expect(response.status).toBe(500);
		expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
		expect(response.headers.has('etag')).toBe(false);
	});

	it('turns a thrown public Worker fetch into a header-complete neutral 500 only', async () => {
		const failure = new Error('private detail');
		const publicResponse = await handlePublicationFetch(
			new Request('https://example.test/p/id'),
			async () => {
				throw failure;
			}
		);
		expect(publicResponse.status).toBe(500);
		expect(publicResponse.headers.get('cache-control')).toBe('no-store, max-age=0');
		expect(publicResponse.headers.get('content-security-policy')).toContain("default-src 'none'");
		expect(await publicResponse.text()).not.toContain('private detail');
		await expect(
			handlePublicationFetch(new Request('https://example.test/private'), async () => {
				throw failure;
			})
		).rejects.toBe(failure);
	});
});
