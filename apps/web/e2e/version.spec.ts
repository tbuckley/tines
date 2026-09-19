import { expect, test } from '@playwright/test';
import type { APIResponse } from '@playwright/test';

const shaPattern = /^[0-9a-f]{40}$/;

async function expectIdentityHeaders(response: APIResponse) {
	const headers = response.headers();
	expect(headers['x-tines-version']).toBe('dev');
	expect(headers['x-tines-commit']).toMatch(shaPattern);
	return { version: headers['x-tines-version'], commit: headers['x-tines-commit'] };
}

test('exposes and decorates the built deployment identity', async ({ request }) => {
	const version = await request.get('/api/version');
	expect(version.status()).toBe(200);
	expect(version.headers()['cache-control']).toBe('no-store');
	const identity = await version.json();
	expect(identity).toEqual({ version: 'dev', commit: expect.stringMatching(shaPattern) });
	expect(await expectIdentityHeaders(version)).toEqual(identity);

	const invalidBearer = await request.get('/api/version', {
		headers: { authorization: 'Bearer invalid' }
	});
	expect(invalidBearer.status()).toBe(200);
	expect(await invalidBearer.json()).toEqual(identity);

	for (const response of [
		await request.get('/api/time'),
		await request.get('/api/v1/projects'),
		await request.get('/api/unknown'),
		await request.post('/api/version'),
		await request.get('/api/auth/get-session')
	]) {
		await expectIdentityHeaders(response);
	}

	const head = await request.head('/api/version');
	expect(head.status()).toBe(200);
	expect(await head.body()).toHaveLength(0);
	expect(await expectIdentityHeaders(head)).toEqual(identity);

	const page = await request.get('/issues');
	expect(page.headers()['x-tines-version']).toBeUndefined();
	expect(page.headers()['x-tines-commit']).toBeUndefined();
});

test('decorates Worker publication failures without weakening their policy', async ({
	request
}) => {
	for (const mode of ['throw', '304']) {
		const response = await request.get('/api/v1/publications/public/e2e-boundary', {
			headers: { 'x-tines-e2e-publication-boundary': mode }
		});
		expect(response.status()).toBe(500);
		expect(response.headers()['cache-control']).toContain('no-store');
		expect(response.headers()['content-security-policy']).toContain("default-src 'none'");
		expect(response.headers()['referrer-policy']).toBe('no-referrer');
		await expectIdentityHeaders(response);
	}
});
