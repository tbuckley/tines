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
import {
	seedMixed,
	verifyMixed,
	user as mixedUser
} from '../../../../../test-fixtures/usage-mixed.mjs';
import { GET } from './+server';
import { GET as RUNS_GET } from '../runs/+server';
import { GET as EVIDENCE_GET } from './evidence/+server';

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

	it('replays frozen scopes and pages exact issue and run evidence', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const first = addIssue(t, { id: 'iss_evidence_a', title: 'First' });
		const second = addIssue(t, { id: 'iss_evidence_b', title: 'Second' });
		for (const [id, issueId, cost] of [
			['arun_evidence_a', first, 0.2],
			['arun_evidence_b', second, 0],
			['arun_evidence_unknown', second, null]
		] as const)
			addRun(t, {
				id,
				issueId,
				runnerId: runner,
				status: 'completed',
				createdAt: NOW - 20,
				endedAt: NOW - 10,
				usage: cost === null ? null : JSON.stringify({ cost_usd: cost, cost_source: 'provider' })
			});
		const reportResult = await get(
			t,
			`?from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}&by=workflow`
		);
		expect(reportResult.response.status).toBe(200);
		const scope = String(reportResult.body.scope);
		const invoke = async (query: string) => {
			const url = new URL(
				`http://test/api/v1/usage/evidence?scope=${encodeURIComponent(scope)}&${query}`
			);
			const response = await EVIDENCE_GET({
				locals: { user: { id: USER, name: 'alice' } },
				platform: { env: t.env, ctx: { waitUntil: () => {} } },
				request: new Request(url),
				url
			} as unknown as Parameters<typeof EVIDENCE_GET>[0]);
			expect(response.status).toBe(200);
			return response.json() as Promise<Record<string, unknown>>;
		};
		const issues = await invoke('kind=issues&limit=1');
		expect(issues).toMatchObject({ total_count: 2, attempt_count: 3 });
		expect((issues.items as { issue_id: string }[])[0].issue_id).toBe(first);
		expect(issues.next_cursor).toEqual(expect.any(String));
		const next = await invoke(
			`kind=issues&limit=1&cursor=${encodeURIComponent(String(issues.next_cursor))}`
		);
		expect((next.items as { issue_id: string }[])[0].issue_id).toBe(second);
		expect(next.previous_cursor).toEqual(expect.any(String));
		const previous = await invoke(
			`kind=issues&limit=1&cursor=${encodeURIComponent(String(next.previous_cursor))}`
		);
		expect((previous.items as { issue_id: string }[])[0].issue_id).toBe(first);
		expect(previous.previous_cursor).toBeNull();
		const runs = await invoke(`kind=runs&member=${first}`);
		expect(runs).toMatchObject({ total_count: 1, attempt_count: 1 });
		expect((runs.items as { id: string }[]).map((item) => item.id)).toEqual(['arun_evidence_a']);
		const replay = await get(t, `?scope=${encodeURIComponent(scope)}`);
		expect(replay.response.status).toBe(200);
		expect(replay.body).toMatchObject({ from: NOW - 100, to: NOW, scope });
	});

	it('keeps a tier filter when replaying a frozen scope', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		for (const [id, tier] of [
			['arun_tier_cheapest', 'cheapest'],
			['arun_tier_balanced', 'balanced']
		] as const)
			addRun(t, {
				id,
				issueId: issue,
				runnerId: runner,
				tier,
				status: 'completed',
				createdAt: NOW - 20,
				endedAt: NOW - 10,
				usage: JSON.stringify({ cost_usd: 0.1, cost_source: 'provider' })
			});
		const report = await get(
			t,
			`?from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}&tier=cheapest`
		);
		expect(report.body).toMatchObject({ matching_total: { finalized_run_count: 1 } });
		const replay = await get(t, `?scope=${encodeURIComponent(String(report.body.scope))}`);
		expect(replay.body).toMatchObject({
			filters: { tier: 'cheapest' },
			matching_total: { finalized_run_count: 1 }
		});
	});

	it('keeps the resolved timezone basis when settings change after a report', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = addIssue(t);
		t.sqlite
			.prepare(
				`INSERT INTO supervisor_settings (user_id, enabled, quota, attempt_limit, budget, updated_at)
				 VALUES (?, 1, ?, 3, ?, ?)`
			)
			.run(
				USER,
				JSON.stringify({ type: 'global_cap', limit: 3 }),
				JSON.stringify({ timezone: 'America/New_York' }),
				NOW
			);
		const report = await get(
			t,
			`?from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}`
		);
		expect(report.body).toMatchObject({
			timezone: 'America/New_York',
			timezone_source: 'supervisor_budget'
		});
		const lifetime = await get(t, `?mode=issue&issue=${issue}`);
		expect(lifetime.body).toMatchObject({
			timezone: 'America/New_York',
			timezone_source: 'supervisor_budget'
		});
		t.sqlite
			.prepare('UPDATE supervisor_settings SET budget = ? WHERE user_id = ?')
			.run(JSON.stringify({ timezone: 'UTC' }), USER);
		const replay = await get(t, `?scope=${encodeURIComponent(String(report.body.scope))}`);
		expect(replay.body).toMatchObject({
			timezone: 'America/New_York',
			timezone_source: 'supervisor_budget'
		});
		const lifetimeReplay = await get(
			t,
			`?scope=${encodeURIComponent(String(lifetime.body.scope))}`
		);
		expect(lifetimeReplay.body).toMatchObject({
			timezone: 'America/New_York',
			timezone_source: 'supervisor_budget'
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
