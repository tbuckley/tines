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

async function get(t: ReturnType<typeof createTestDb>, query: string) {
	const url = new URL(`http://test/api/v1/runs${query}`);
	const event = {
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url),
		url
	};
	const response = await GET(event as unknown as Parameters<typeof GET>[0]);
	return { response, body: (await response.json()) as Record<string, unknown> };
}

describe('GET /api/v1/runs usage evidence', () => {
	it('wires accounting status and redacts pending rows on the HTTP boundary', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		addRun(t, {
			id: 'unpriced',
			issueId: issue,
			runnerId: runner,
			status: 'failed',
			endedAt: NOW - 2,
			usage: JSON.stringify({ input_tokens: 1 })
		});
		addRun(t, {
			id: 'priced',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			endedAt: NOW - 1,
			usage: JSON.stringify({ cost_usd: 0, cost_source: 'provider' })
		});
		addRun(t, {
			id: 'later',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			outcome: 'advanced',
			createdAt: NOW - 10,
			endedAt: NOW + 1,
			usage: JSON.stringify({ cost_usd: 42 })
		});
		const from = new Date(NOW - 100).toISOString();
		const to = new Date(NOW).toISOString();
		const finalized = await get(
			t,
			`?population=finalized&from=${from}&to=${to}&accounting_status=priced`
		);
		expect((finalized.body.items as { id: string }[]).map((run) => run.id)).toEqual(['priced']);
		expect(finalized.body).toMatchObject({
			usage_window: { from: NOW - 100, to: NOW, cursor_version: 'usage-runs-v1' }
		});
		const pending = await get(t, `?population=pending&from=${from}&to=${to}`);
		expect(pending.body.items).toEqual([
			expect.objectContaining({ id: 'later', accounting_status: 'pending', pending_at: NOW })
		]);
		expect(JSON.stringify(pending.body.items)).not.toContain('"usage"');
	});

	it('rejects a usage cursor replayed with different filters', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		for (let i = 0; i < 2; i++)
			addRun(t, {
				id: `run_${i}`,
				issueId: issue,
				runnerId: runner,
				status: 'completed',
				endedAt: NOW - 1 - i
			});
		const bounds = `population=finalized&from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}`;
		const first = await get(t, `?${bounds}&limit=1`);
		const cursor = first.body.next_cursor as string;
		const mismatch = await get(
			t,
			`?${bounds}&limit=1&outcome=advanced&cursor=${encodeURIComponent(cursor)}`
		);
		expect(mismatch.response.status).toBe(422);
		expect(mismatch.body).toMatchObject({ error: { code: 'cursor_mismatch' } });
	});
});
