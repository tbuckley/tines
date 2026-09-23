import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { seedBase, USER } from '$lib/server/supervisor/test-fixtures';
import { GET } from './+server';

async function inventory() {
	const t = createTestDb();
	seedBase(t);
	const url = new URL('http://test/api/v1/state-retirement/inventory');
	const request = new Request(url);
	const event = {
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request,
		url
	};
	return GET(event as unknown as Parameters<typeof GET>[0]);
}

describe('GET /api/v1/state-retirement/inventory', () => {
	it('returns an owner-scoped read-only inventory', async () => {
		const response = await inventory();
		const body = (await response.json()) as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ version: 1, owner_id: USER, diagnostics: [] });
		expect(body.inventory_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});
