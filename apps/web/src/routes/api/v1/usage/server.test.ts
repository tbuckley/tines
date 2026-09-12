import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import {
	addIssue,
	addRun,
	addRunner,
	NOW,
	seedBase,
	USER
} from '$lib/server/supervisor/test-fixtures';
import { GET } from './+server';
import { GET as RUNS_GET } from '../runs/+server';

async function get(t: ReturnType<typeof createTestDb>, query: string) {
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

async function getRuns(t: ReturnType<typeof createTestDb>, query: string) {
	const url = new URL(`http://test/api/v1/runs${query}`);
	const event = {
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url),
		url
	};
	const response = await RUNS_GET(event as unknown as Parameters<typeof RUNS_GET>[0]);
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

	it('independently reconciles a mixed 137-run report with every raw evidence page', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		let expectedExact = 0;
		for (let i = 0; i < 137; i++) {
			const kind = i % 3;
			const usage =
				kind === 0
					? JSON.stringify({ cost_usd: i / 100, cost_source: 'provider' })
					: kind === 1
						? JSON.stringify({ input_tokens: i })
						: null;
			if (kind === 0) expectedExact += i;
			addRun(t, {
				id: `mixed_${String(i).padStart(3, '0')}`,
				issueId: issue,
				runnerId: runner,
				status: 'completed',
				outcome: i % 2 ? 'advanced' : 'stalled',
				endedAt: NOW - Math.floor(i / 4),
				usage
			});
		}
		const from = new Date(NOW - 100).toISOString();
		const to = new Date(NOW + 1).toISOString();
		const report = await get(t, `?from=${from}&to=${to}&by=outcome`);
		expect(report.response.status).toBe(200);
		expect(report.body).toMatchObject({
			scope_total: {
				finalized_run_count: 137,
				priced_run_count: 46,
				unpriced_run_count: 46,
				unreported_run_count: 45,
				cost_usd_exact: String(expectedExact / 100)
			}
		});

		const ids: string[] = [];
		let cursor: string | null = null;
		do {
			const page = await getRuns(
				t,
				`?population=finalized&from=${from}&to=${to}&limit=17${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
			);
			expect(page.response.status).toBe(200);
			ids.push(...(page.body.items as { id: string }[]).map((run) => run.id));
			cursor = page.body.next_cursor as string | null;
		} while (cursor);
		expect(ids).toHaveLength(137);
		expect(new Set(ids).size).toBe(137);
	});
});
