import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import {
	addIssue,
	addRun,
	addRunKey,
	addRunner,
	CLOSED,
	NOW,
	PROJECT,
	seedBase,
	USER
} from '$lib/server/supervisor/test-fixtures';
import {
	seedMixed,
	verifyMixed,
	verifyMixedCohort,
	user as mixedUser
} from '../../../../../test-fixtures/usage-mixed.mjs';
import { GET } from './+server';
import { GET as RUNS_GET } from '../runs/+server';
import { GET as EVIDENCE_GET } from './evidence/+server';
import { sha256Hex } from '$lib/server/api/core';

function completionEntry(
	t: ReturnType<typeof createTestDb>,
	id: string,
	issueId: string,
	createdAt: number,
	projectId = PROJECT
) {
	t.sqlite
		.prepare(
			`INSERT INTO event (id,user_id,type,actor_user_id,issue_id,project_id,payload,created_at)
			 VALUES (?,?,?,?,?,?,?,?)`
		)
		.run(
			id,
			USER,
			'issue.transitioned',
			USER,
			issueId,
			projectId,
			JSON.stringify({
				state_entry_version: 1,
				workflow_id: 'wf_standard',
				workflow_name: 'Engineering',
				to_state_id: CLOSED,
				to_state_name: 'Closed',
				to_state_category: 'done'
			}),
			createdAt
		);
}

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

async function getWithBearer(t: ReturnType<typeof createTestDb>, query: string, bearer: string) {
	t.env.BETTER_AUTH_SECRET = 'usage-route-test-secret';
	const url = new URL(`http://test/api/v1/usage${query}`);
	const response = await GET({
		locals: {},
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url, { headers: { authorization: `Bearer ${bearer}` } }),
		url
	} as unknown as Parameters<typeof GET>[0]);
	return { response, body: (await response.json()) as Record<string, unknown> };
}

async function evidenceWithBearer(
	t: ReturnType<typeof createTestDb>,
	query: string,
	bearer: string
) {
	t.env.BETTER_AUTH_SECRET = 'usage-route-test-secret';
	const url = new URL(`http://test/api/v1/usage/evidence${query}`);
	const response = await EVIDENCE_GET({
		locals: {},
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url, { headers: { authorization: `Bearer ${bearer}` } }),
		url
	} as unknown as Parameters<typeof EVIDENCE_GET>[0]);
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

	it('serves and freezes an explicit completion cohort scope', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = addIssue(t, { id: 'iss_cohort_route', state: CLOSED });
		completionEntry(t, 'evt_cohort_route', issue, NOW - 20);
		const query = `?mode=cohort&workflow=wf_standard&from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}`;
		const initial = await get(t, query);
		expect(initial.response.status).toBe(200);
		expect(initial.body).toMatchObject({
			mode: 'cohort',
			selection_basis: 'all_current_done',
			selected_states: [{ id: CLOSED, name: 'Closed', category: 'done' }],
			counters: { distinct_issue_count: 1, zero_run_issue_count: 1 }
		});
		expect(initial.body.scope).toEqual(expect.any(String));

		t.sqlite.prepare(`UPDATE workflow_state SET category='active' WHERE id=?`).run(CLOSED);
		const replay = await get(t, `?scope=${encodeURIComponent(String(initial.body.scope))}`);
		expect(replay.response.status).toBe(200);
		expect(replay.body).toMatchObject({
			mode: 'cohort',
			selection_basis: 'all_current_done',
			selected_states: [{ id: CLOSED, name: 'Closed', category: 'done' }],
			counters: { distinct_issue_count: 1 }
		});
		expect(replay.body.scope).toBe(initial.body.scope);
	});

	it('filters cohort reports and evidence by the acting key project scope', async () => {
		const t = createTestDb();
		seedBase(t);
		t.sqlite.exec(
			`INSERT INTO project (id, user_id, name, created_at, updated_at)
			 VALUES ('prj_cohort_other', '${USER}', 'other', ${NOW}, ${NOW})`
		);
		const visible = addIssue(t, { id: 'iss_cohort_visible', state: CLOSED });
		const hidden = addIssue(t, {
			id: 'iss_cohort_hidden',
			state: CLOSED,
			project: 'prj_cohort_other'
		});
		const hiddenEvent = addIssue(t, { id: 'iss_cohort_hidden_event', state: CLOSED });
		completionEntry(t, 'evt_cohort_visible', visible, NOW - 30, PROJECT);
		completionEntry(t, 'evt_cohort_hidden', hidden, NOW - 20, 'prj_cohort_other');
		completionEntry(t, 'evt_cohort_hidden_event', hiddenEvent, NOW - 10, 'prj_cohort_other');
		const bearer = 'cohort-scoped-key';
		t.sqlite
			.prepare(
				`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, permissions, created_at)
				 VALUES ('key_cohort_scoped', ?, 'cohort', ?, 'tines_cohort', ?, ?)`
			)
			.run(
				USER,
				await sha256Hex(bearer),
				JSON.stringify({
					version: 1,
					projects: { access: 'read', scope: [PROJECT] },
					workspace: 'read',
					control_plane: 'read'
				}),
				NOW
			);

		const report = await getWithBearer(
			t,
			`?mode=cohort&workflow=wf_standard&from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}`,
			bearer
		);
		expect(report.response.status).toBe(200);
		expect(report.body).toMatchObject({ counters: { distinct_issue_count: 1 } });

		const scope = String(report.body.scope);
		const evidence = await evidenceWithBearer(
			t,
			`?scope=${encodeURIComponent(scope)}&kind=issues`,
			bearer
		);
		expect(evidence.response.status).toBe(200);
		expect(evidence.body).toMatchObject({
			total_count: 1,
			items: [{ issue_id: visible }]
		});
		expect(JSON.stringify(evidence.body)).not.toContain(hidden);
		const entries = await evidenceWithBearer(
			t,
			`?scope=${encodeURIComponent(scope)}&kind=entries`,
			bearer
		);
		expect(entries.response.status).toBe(200);
		expect(entries.body).toMatchObject({
			total_count: 1,
			items: [{ event_id: 'evt_cohort_visible' }]
		});

		const hiddenScope = await get(
			t,
			`?mode=cohort&workflow=wf_standard&project=prj_cohort_other&from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}`
		);
		expect(hiddenScope.response.status).toBe(200);
		const replay = await evidenceWithBearer(
			t,
			`?scope=${encodeURIComponent(String(hiddenScope.body.scope))}&kind=issues`,
			bearer
		);
		expect(replay.response.status).toBe(403);
		expect(replay.body).toMatchObject({ error: { code: 'insufficient_permissions' } });
	});

	it('rejects cohort reports for a bound run key', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = addIssue(t);
		const runner = addRunner(t);
		const run = addRun(t, {
			id: 'arun_cohort_route',
			issueId: issue,
			runnerId: runner,
			status: 'running'
		});
		const keyId = addRunKey(t, run, { id: 'key_cohort_run' });
		const bearer = 'cohort-run-key';
		t.sqlite
			.prepare('UPDATE api_key SET key_hash = ? WHERE id = ?')
			.run(await sha256Hex(bearer), keyId);

		const result = await getWithBearer(
			t,
			`?mode=cohort&workflow=wf_standard&from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}`,
			bearer
		);
		expect(result.response.status).toBe(403);
		expect(result.body).toMatchObject({ error: { code: 'run_key_forbidden' } });
	});

	it('pages cohort members including no-run issues and cutoff-redacted attempts', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const finalized = addIssue(t, { id: 'iss_cohort_finalized', state: CLOSED });
		const noRun = addIssue(t, { id: 'iss_cohort_no_run', state: CLOSED });
		completionEntry(t, 'evt_cohort_finalized', finalized, NOW - 30);
		completionEntry(t, 'evt_cohort_no_run', noRun, NOW - 20);
		const nonmember = addIssue(t, { id: 'iss_cohort_nonmember' });
		t.sqlite.exec(`
			INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt)
			VALUES ('u_foreign_cohort','bob','cohort-foreign@example.com',1,${NOW},${NOW});
			INSERT INTO project (id,user_id,name,created_at,updated_at)
			VALUES ('prj_foreign_cohort','u_foreign_cohort','private',${NOW},${NOW});
		`);
		const foreignIdentity = addIssue(t, {
			id: 'iss_foreign_cohort_identity',
			project: 'prj_foreign_cohort'
		});
		completionEntry(t, 'evt_owned_foreign_identity', foreignIdentity, NOW - 15);
		t.sqlite
			.prepare(
				`INSERT INTO event (id,user_id,type,actor_user_id,issue_id,project_id,payload,created_at)
				 VALUES (?,?,?,?,?,?,?,?)`
			)
			.run(
				'evt_cohort_nonmember',
				USER,
				'issue.transitioned',
				USER,
				nonmember,
				PROJECT,
				JSON.stringify({
					state_entry_version: 1,
					workflow_id: 'wf_standard',
					workflow_name: 'Engineering',
					to_state_id: 'st_open',
					to_state_name: 'Open',
					to_state_category: 'active'
				}),
				NOW - 10
			);
		addRun(t, {
			id: 'arun_cohort_finalized',
			issueId: finalized,
			runnerId: runner,
			status: 'completed',
			createdAt: NOW - 50,
			endedAt: NOW - 10,
			usage: JSON.stringify({ cost_usd: 2, cost_source: 'provider' })
		});
		addRun(t, {
			id: 'arun_cohort_pending',
			issueId: finalized,
			runnerId: runner,
			status: 'completed',
			createdAt: NOW - 5,
			endedAt: NOW + 10,
			usage: JSON.stringify({ cost_usd: 99, cost_source: 'provider' })
		});
		addRun(t, {
			id: 'arun_cohort_exact_cutoff',
			issueId: finalized,
			runnerId: runner,
			status: 'completed',
			createdAt: NOW - 4,
			endedAt: NOW,
			usage: JSON.stringify({ cost_usd: 77, cost_source: 'provider' })
		});
		const report = await get(
			t,
			`?mode=cohort&workflow=wf_standard&from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}`
		);
		const evidence = async (query: string) => {
			const url = new URL(
				`http://test/api/v1/usage/evidence?scope=${encodeURIComponent(String(report.body.scope))}&${query}`
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
		const issues = await evidence('kind=issues');
		expect(issues).toMatchObject({
			total_count: 2,
			attempt_count: 3,
			pending_count: 2,
			from: NOW - 100,
			to: NOW,
			observed_through: expect.any(Number),
			counters: { distinct_issue_count: 2, attempt_count: 3, pending_count: 2 },
			history: { qualifying_fact_count: 3 }
		});
		expect((issues.items as { issue_id: string }[]).map((item) => item.issue_id).sort()).toEqual([
			finalized,
			noRun
		]);
		const pending = await evidence(`kind=runs&population=pending&member=${finalized}`);
		expect(pending).toMatchObject({
			total_count: 2,
			attempt_count: 3,
			pending_count: 2,
			matching_total: { cost_usd_exact: '2' },
			parent_matching_total: { cost_usd_exact: '2' },
			counters: { distinct_issue_count: 1, attempt_count: 3, pending_count: 2 },
			parent_counters: { distinct_issue_count: 2, attempt_count: 3, pending_count: 2 }
		});
		expect((pending.items as { id: string }[]).map((item) => item.id).sort()).toEqual([
			'arun_cohort_exact_cutoff',
			'arun_cohort_pending'
		]);
		for (const item of pending.items as Record<string, unknown>[]) {
			expect(item).not.toHaveProperty('usage');
			expect(item).not.toHaveProperty('ended_at');
			expect(item).not.toHaveProperty('outcome');
		}
		const empty = await evidence(`kind=runs&member=${noRun}`);
		expect(empty).toMatchObject({ total_count: 0, items: [] });
		const entries = await evidence('kind=entries&limit=1');
		expect(entries).toMatchObject({
			total_count: 2,
			population: 'all',
			sort: 'time',
			items: [{ event_id: 'evt_cohort_no_run', qualifies: 1, chosen: 1 }]
		});
		expect(entries.next_cursor).toEqual(expect.any(String));
		const nextEntries = await evidence(
			`kind=entries&limit=1&cursor=${encodeURIComponent(String(entries.next_cursor))}`
		);
		expect(nextEntries).toMatchObject({
			total_count: 2,
			items: [{ event_id: 'evt_cohort_finalized', qualifies: 1, chosen: 1 }]
		});
		expect(JSON.stringify([entries, nextEntries])).not.toContain('evt_cohort_nonmember');
		expect(JSON.stringify([entries, nextEntries])).not.toContain('evt_owned_foreign_identity');
		const previousEntries = await evidence(
			`kind=entries&limit=1&cursor=${encodeURIComponent(String(nextEntries.previous_cursor))}`
		);
		expect(previousEntries).toMatchObject({
			total_count: 2,
			items: [{ event_id: 'evt_cohort_no_run', qualifies: 1, chosen: 1 }]
		});
		expect(JSON.stringify(previousEntries)).not.toContain('evt_owned_foreign_identity');
	});

	it('walks more than one hundred equal-key no-run members and entries exactly once', async () => {
		const t = createTestDb();
		seedBase(t);
		const expectedIssues: string[] = [];
		const expectedEntries: string[] = [];
		for (let index = 0; index < 105; index++) {
			const suffix = String(index).padStart(3, '0');
			const issue = addIssue(t, { id: `iss_cohort_many_${suffix}`, state: CLOSED });
			const event = `evt_cohort_many_${suffix}`;
			completionEntry(t, event, issue, NOW - 20);
			expectedIssues.push(issue);
			expectedEntries.push(event);
		}
		const report = await get(
			t,
			`?mode=cohort&workflow=wf_standard&from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}`
		);
		expect(report.body).toMatchObject({
			counters: { distinct_issue_count: 105, zero_run_issue_count: 105, attempt_count: 0 }
		});

		const walk = async (kind: 'issues' | 'entries') => {
			const found: string[] = [];
			let cursor: string | null = null;
			do {
				const url = new URL('http://test/api/v1/usage/evidence');
				url.searchParams.set('scope', String(report.body.scope));
				url.searchParams.set('kind', kind);
				url.searchParams.set('limit', '100');
				if (cursor) url.searchParams.set('cursor', cursor);
				const response = await EVIDENCE_GET({
					locals: { user: { id: USER, name: 'alice' } },
					platform: { env: t.env, ctx: { waitUntil: () => {} } },
					request: new Request(url),
					url
				} as unknown as Parameters<typeof EVIDENCE_GET>[0]);
				expect(response.status).toBe(200);
				const page = (await response.json()) as {
					items: { issue_id?: string; event_id?: string }[];
					next_cursor: string | null;
					total_count: number;
				};
				expect(page.total_count).toBe(105);
				found.push(...page.items.map((item) => item.event_id ?? item.issue_id!));
				cursor = page.next_cursor;
			} while (cursor);
			return found;
		};

		expect(await walk('issues')).toEqual(expectedIssues);
		expect(await walk('entries')).toEqual(expectedEntries);
	});

	it('rejects contradictory and unprovable cohort selections', async () => {
		const t = createTestDb();
		seedBase(t);
		const bounds = `from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}`;
		const contradictory = await get(t, `?mode=cohort&workflow=wf_standard&state=st_open&${bounds}`);
		expect(contradictory.response.status).toBe(422);
		expect(contradictory.body).toMatchObject({
			error: { code: 'invalid_field', details: { field: 'state' } }
		});
		const unknownState = await get(
			t,
			`?mode=cohort&workflow=wf_standard&done_state=st_missing&${bounds}`
		);
		expect(unknownState.response.status).toBe(404);
	});

	it('reports whole-lifetime attempt and pending counts on finalized evidence', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		addRun(t, {
			id: 'arun_lifetime_finalized',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			createdAt: NOW - 20,
			endedAt: NOW - 10,
			usage: JSON.stringify({ cost_usd: 0, cost_source: 'provider' })
		});
		addRun(t, {
			id: 'arun_lifetime_pending',
			issueId: issue,
			runnerId: runner,
			status: 'running',
			createdAt: NOW - 5
		});
		const lifetime = await get(t, `?mode=issue&issue=${issue}`);
		const url = new URL(
			`http://test/api/v1/usage/evidence?scope=${encodeURIComponent(String(lifetime.body.scope))}&kind=runs`
		);
		const response = await EVIDENCE_GET({
			locals: { user: { id: USER, name: 'alice' } },
			platform: { env: t.env, ctx: { waitUntil: () => {} } },
			request: new Request(url),
			url
		} as unknown as Parameters<typeof EVIDENCE_GET>[0]);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			total_count: 1,
			attempt_count: 2,
			pending_count: 1,
			matching_total: { finalized_run_count: 1, cost_usd_exact: '0' }
		});
	});

	it('uses a physically narrow projection for reachable historical pending evidence', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		addRun(t, {
			id: 'arun_pending_later_facts',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			outcome: 'advanced',
			createdAt: NOW - 5,
			endedAt: NOW,
			usage: JSON.stringify({ cost_usd: 99, cost_source: 'provider', input_tokens: 123 })
		});
		const report = await get(
			t,
			`?from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}`
		);
		const queries = t.spyOnQueries();
		const url = new URL('http://test/api/v1/usage/evidence');
		url.searchParams.set('scope', String(report.body.pending_scope));
		url.searchParams.set('kind', 'runs');
		url.searchParams.set('population', 'pending');
		const response = await EVIDENCE_GET({
			locals: { user: { id: USER, name: 'alice' } },
			platform: { env: t.env, ctx: { waitUntil: () => {} } },
			request: new Request(url),
			url
		} as unknown as Parameters<typeof EVIDENCE_GET>[0]);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			items: [{ id: 'arun_pending_later_facts', accounting_status: 'pending' }]
		});
		const scan = queries().find(
			(sql) => sql.includes('from "agent_run"') && sql.includes('limit ?')
		)!;
		const projection = scan.slice(0, scan.indexOf(' from '));
		expect(projection).not.toContain('"agent_run"."usage"');
		expect(projection).not.toContain('"agent_run"."outcome"');
		expect(projection).not.toContain('"agent_run"."ended_at"');
		expect(projection).not.toContain('"agent_run"."status"');
	});

	it('mints every project group scope with its exact group predicate', async () => {
		const t = createTestDb();
		seedBase(t);
		t.sqlite
			.prepare(
				'INSERT INTO project (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
			)
			.run('prj_group_two', USER, 'second', NOW, NOW);
		const runner = addRunner(t);
		const first = addIssue(t, { id: 'iss_group_first' });
		const second = addIssue(t, { id: 'iss_group_second', project: 'prj_group_two' });
		for (const [id, issueId, cost] of [
			['arun_group_first', first, 1],
			['arun_group_second', second, 2]
		] as const)
			addRun(t, {
				id,
				issueId,
				runnerId: runner,
				status: 'completed',
				createdAt: NOW - 20,
				endedAt: NOW - 10,
				usage: JSON.stringify({ cost_usd: cost, cost_source: 'provider' })
			});
		const report = await get(
			t,
			`?from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}&by=project`
		);
		for (const group of report.body.groups as {
			dimension: { id: string };
			aggregate: { cost_usd_exact: string };
			scope: string;
		}[]) {
			const url = new URL('http://test/api/v1/usage/evidence');
			url.searchParams.set('scope', group.scope);
			url.searchParams.set('kind', 'issues');
			const response = await EVIDENCE_GET({
				locals: { user: { id: USER, name: 'alice' } },
				platform: { env: t.env, ctx: { waitUntil: () => {} } },
				request: new Request(url),
				url
			} as unknown as Parameters<typeof EVIDENCE_GET>[0]);
			const evidence = (await response.json()) as {
				items: { issue_id: string }[];
				matching_total: { cost_usd_exact: string };
			};
			expect(evidence.items.map((item) => item.issue_id)).toEqual([
				group.dimension.id === 'prj_group_two' ? second : first
			]);
			expect(evidence.matching_total.cost_usd_exact).toBe(group.aggregate.cost_usd_exact);
		}
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

	it('pages more than one hundred equal-cost issues completely and deterministically', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const ids: string[] = [];
		for (let index = 0; index < 105; index++) {
			const issue = `iss_many_${String(index).padStart(3, '0')}`;
			ids.push(issue);
			addIssue(t, { id: issue });
			addRun(t, {
				id: `arun_many_${String(index).padStart(3, '0')}`,
				issueId: issue,
				runnerId: runner,
				status: 'completed',
				createdAt: NOW - 20,
				endedAt: NOW - 10,
				usage: JSON.stringify({ cost_usd: 0.01, cost_source: 'provider' })
			});
		}
		const report = await get(
			t,
			`?from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}`
		);
		const evidence = async (cursor?: string) => {
			const url = new URL('http://test/api/v1/usage/evidence');
			url.searchParams.set('scope', String(report.body.scope));
			url.searchParams.set('kind', 'issues');
			url.searchParams.set('limit', '100');
			if (cursor) url.searchParams.set('cursor', cursor);
			const response = await EVIDENCE_GET({
				locals: { user: { id: USER, name: 'alice' } },
				platform: { env: t.env, ctx: { waitUntil: () => {} } },
				request: new Request(url),
				url
			} as unknown as Parameters<typeof EVIDENCE_GET>[0]);
			expect(response.status).toBe(200);
			return response.json() as Promise<Record<string, unknown>>;
		};
		const first = await evidence();
		const second = await evidence(String(first.next_cursor));
		const found = [
			...(first.items as { issue_id: string }[]),
			...(second.items as { issue_id: string }[])
		];
		expect(found.map((item) => item.issue_id)).toEqual(ids);
		expect(first).toMatchObject({ total_count: 105, attempt_count: 105 });
		expect(second.next_cursor).toBeNull();
	});

	it('sorts exponent-form run costs numerically across cursor boundaries in both directions', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		for (const [id, cost] of [
			['arun_exponent_small', 1e-7],
			['arun_decimal_middle', 0.000001],
			['arun_decimal_large', 0.000002]
		] as const)
			addRun(t, {
				id,
				issueId: issue,
				runnerId: runner,
				status: 'completed',
				createdAt: NOW - 20,
				endedAt: NOW - 10,
				usage: JSON.stringify({ cost_usd: cost, cost_source: 'provider' })
			});
		const report = await get(
			t,
			`?from=${new Date(NOW - 100).toISOString()}&to=${new Date(NOW).toISOString()}`
		);
		const walk = async (direction: 'asc' | 'desc') => {
			const ids: string[] = [];
			let cursor: string | null = null;
			do {
				const url = new URL('http://test/api/v1/usage/evidence');
				url.searchParams.set('scope', String(report.body.scope));
				url.searchParams.set('kind', 'runs');
				url.searchParams.set('direction', direction);
				url.searchParams.set('limit', '1');
				if (cursor) url.searchParams.set('cursor', cursor);
				const response = await EVIDENCE_GET({
					locals: { user: { id: USER, name: 'alice' } },
					platform: { env: t.env, ctx: { waitUntil: () => {} } },
					request: new Request(url),
					url
				} as unknown as Parameters<typeof EVIDENCE_GET>[0]);
				expect(response.status).toBe(200);
				const page = (await response.json()) as {
					items: { id: string }[];
					next_cursor: string | null;
				};
				ids.push(...page.items.map((item) => item.id));
				cursor = page.next_cursor;
			} while (cursor);
			return ids;
		};
		expect(await walk('asc')).toEqual([
			'arun_exponent_small',
			'arun_decimal_middle',
			'arun_decimal_large'
		]);
		expect(await walk('desc')).toEqual([
			'arun_decimal_large',
			'arun_decimal_middle',
			'arun_exponent_small'
		]);
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
		const request = async (path: string, query: Record<string, string>) => {
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
					: path === '/usage/evidence'
						? await EVIDENCE_GET(event as unknown as Parameters<typeof EVIDENCE_GET>[0])
						: await RUNS_GET(event as unknown as Parameters<typeof RUNS_GET>[0]);
			expect(response.status).toBe(200);
			return response.json();
		};
		await verifyMixed(request);
		await verifyMixedCohort(request);
	}, 15_000);
});
