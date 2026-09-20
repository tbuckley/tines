import { describe, expect, it } from 'vitest';
import { GET, HEAD } from './+server';

describe('GET /api/version', () => {
	it('returns the build identity without authentication and disables caching', async () => {
		const response = await GET({} as never);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({
			version: 'dev',
			commit: expect.stringMatching(/^(?:[0-9a-f]{40}|unknown)$/)
		});
	});

	it('answers HEAD with the same cache policy and no body', async () => {
		const response = await HEAD({} as never);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.text()).toBe('');
	});
});
