import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { addIssue, NOW, seedBase, USER } from '$lib/server/supervisor/test-fixtures';
import {
	seedMixed,
	verifyMixed,
	user as mixedUser
} from '../../../../../test-fixtures/usage-mixed.mjs';
import { GET } from './+server';
import { GET as RUNS_GET } from '../runs/+server';

async function get(t: ReturnType<typeof createTestDb>, query: string) {
	t.env.BETTER_AUTH_SECRET = 'usage-route-test-secret';
	const url = new URL(`http://test/api/v1/usage${query}`);
	const event = {
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url),
		url
	};
	const response = await GET(event as unknown as Parameters<typeof GET>[0]);
	return { response, body: (await response.json()) as Record<string, unknown> };
}

describe('GET /api/v1/usage validation and authorization', () => {
	it('validates malformed periods before retained filter authorization', async () => {
		const t = createTestDb();
		seedBase(t);
		const result = await get(t, '?from=2026-02-30&to=2026-03-02&project=prj_missing');
		expect(result.response.status).toBe(422);
		expect(result.body).toMatchObject({
			error: { code: 'invalid_usage_period', details: { field: 'from/to' } }
		});
	});

	it('rejects an unowned retained identity instead of returning an empty report', async () => {
		const t = createTestDb();
		seedBase(t);
		const result = await get(
			t,
			`?from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}&runner=rnr_foreign`
		);
		expect(result.response.status).toBe(404);
		expect(result.body).toMatchObject({ error: { code: 'not_found' } });
	});

	it('serves direct issue lifetime mode and rejects contradictory period options', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = addIssue(t);
		const ok = await get(t, `?mode=issue&issue=${issue}`);
		expect(ok.response.status).toBe(200);
		expect(ok.body).toMatchObject({ mode: 'issue', issue: { issue_id: issue, attempt_count: 0 } });
		const bad = await get(t, `?mode=issue&issue=${issue}&window=7d`);
		expect(bad.response.status).toBe(422);
		expect(bad.body).toMatchObject({
			error: { code: 'invalid_field', details: { field: 'window' } }
		});
	});

	it('reconciles the independent multidimensional manifest through both real handlers', async () => {
		const t = createTestDb();
		t.env.BETTER_AUTH_SECRET = 'usage-route-test-secret';
		seedMixed(t.sqlite);
		await verifyMixed(async (path: string, query: Record<string, string>) => {
			const url = new URL(`http://test/api/v1${path}?${new URLSearchParams(query)}`);
			const event = {
				locals: { user: { id: mixedUser, name: 'mixed' } },
				platform: { env: t.env, ctx: { waitUntil: () => {} } },
				request: new Request(url),
				url
			};
			const response =
				path === '/usage'
					? await GET(event as unknown as Parameters<typeof GET>[0])
					: await RUNS_GET(event as unknown as Parameters<typeof RUNS_GET>[0]);
			expect(response.status).toBe(200);
			return response.json();
		});
	});
});
