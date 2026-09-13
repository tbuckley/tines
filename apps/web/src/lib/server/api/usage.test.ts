import { describe, expect, it } from 'vitest';
import {
	addIssue,
	addRun,
	addRunner,
	NOW,
	PROJECT,
	seedBase,
	USER
} from '../supervisor/test-fixtures';
import { createTestDb } from './test-db';
import { getIssueUsage, getUsage } from './usage';

describe('period usage ledger', () => {
	it('scans more than two public pages and preserves cheap typical cost plus a large outlier', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		for (let i = 0; i < 100; i++) {
			addRun(t, {
				id: `cheap_${i}`,
				issueId: issue,
				runnerId: runner,
				status: 'completed',
				outcome: 'advanced',
				createdAt: NOW - 2000,
				endedAt: NOW - 1000 + i,
				usage: JSON.stringify({ cost_usd: 0.01, cost_source: 'provider', input_tokens: 1 })
			});
		}
		addRun(t, {
			id: 'outlier',
			issueId: issue,
			runnerId: runner,
			status: 'failed',
			outcome: 'stalled',
			createdAt: NOW - 2000,
			endedAt: NOW - 500,
			usage: JSON.stringify({ cost_usd: 100, cost_source: 'provider', input_tokens: 10 })
		});
		addRun(t, {
			id: 'pending',
			issueId: issue,
			runnerId: runner,
			createdAt: NOW - 100,
			endedAt: null
		});

		const report = await getUsage(
			t.db,
			USER,
			{
				from: new Date(NOW - 10_000).toISOString(),
				to: new Date(NOW).toISOString(),
				by: 'workflow'
			},
			NOW + 1000
		);
		expect(report).toMatchObject({
			accounting_basis: 'finalized_by_ended_at_v1',
			scope_total: { finalized_run_count: 101, cost_usd_exact: '101' },
			matching_total: { finalized_run_count: 101, cost_usd_exact: '101' },
			pending: { scope_count: 1, matching_count: 1 }
		});
		expect(report.groups).toHaveLength(1);
		expect(report.groups[0].aggregate.distribution).toMatchObject({
			mean_cost_usd: 1,
			median_cost_usd: 0.01,
			p95_cost_usd: 0.01,
			max_cost_usd: 100
		});
	});

	it('keeps scope total outside analytical filters and counts explicit zero as priced', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		addRun(t, {
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			outcome: 'advanced',
			endedAt: NOW - 2,
			usage: JSON.stringify({ cost_usd: 0, cost_source: 'provider' })
		});
		addRun(t, {
			issueId: issue,
			runnerId: runner,
			status: 'failed',
			outcome: 'stalled',
			endedAt: NOW - 1,
			usage: JSON.stringify({ input_tokens: 2, cost_source: 'none' })
		});
		const report = await getUsage(
			t.db,
			USER,
			{
				from: new Date(NOW - 100).toISOString(),
				to: new Date(NOW).toISOString(),
				project: PROJECT,
				outcome: 'advanced',
				accounting_status: 'priced',
				by: 'outcome'
			},
			NOW + 1
		);
		expect(report.scope_total).toMatchObject({
			finalized_run_count: 2,
			priced_run_count: 1,
			coverage: 'partial'
		});
		expect(report.matching_total).toMatchObject({
			finalized_run_count: 1,
			priced_run_count: 1,
			cost_usd_exact: '0'
		});
		expect(report.pending.unapplied_filters).toEqual(['outcome', 'accounting_status']);
	});
});

describe('direct issue lifetime usage', () => {
	it('separates finalized-before-cutoff usage from pending attempts', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		addRun(t, {
			id: 'priced',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			createdAt: NOW - 20,
			endedAt: NOW - 10,
			usage: JSON.stringify({ cost_usd: 0, cost_source: 'provider', input_tokens: 4 })
		});
		addRun(t, {
			id: 'ended_at_cutoff',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			createdAt: NOW - 5,
			endedAt: NOW,
			usage: JSON.stringify({ cost_usd: 99, cost_source: 'provider' })
		});

		const report = await getIssueUsage(t.db, USER, issue, NOW);
		expect(report).toMatchObject({
			mode: 'issue',
			cutoff: NOW,
			issue: {
				issue_id: issue,
				attempt_count: 2,
				pending_count: 1,
				fully_priced: false,
				aggregate: { finalized_run_count: 1, priced_run_count: 1, cost_usd_exact: '0' }
			}
		});
	});
});
