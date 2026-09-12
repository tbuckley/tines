import { describe, expect, it } from 'vitest';
import { recordDispatchEffects } from './test-dispatch-effects';
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
import { cancelRunForRequest, getRun, listRuns } from './runs';
import type { ActorContext } from './core';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

describe('dispatch effects: cancelRunForRequest', () => {
	it('signals only for a winning cancellation', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const run = addRun(t, { issueId: addIssue(t), runnerId: runner });
		const effects = recordDispatchEffects();
		await cancelRunForRequest(t.db, t.env, actor, effects, run);
		expect(effects.count()).toBe(1);
		await expect(cancelRunForRequest(t.db, t.env, actor, effects, run)).rejects.toMatchObject({
			code: 'run_already_ended'
		});
		expect(effects.count()).toBe(1);
	});

	it('stays silent when the terminal flip batch rejects', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const run = addRun(t, { issueId: addIssue(t), runnerId: runner });
		const effects = recordDispatchEffects();
		t.env.DB.batch = async () => {
			throw new Error('injected cancellation batch failure');
		};
		await expect(cancelRunForRequest(t.db, t.env, actor, effects, run)).rejects.toThrow(
			'injected cancellation batch failure'
		);
		expect(effects.count()).toBe(0);
		expect(t.all('SELECT status FROM agent_run WHERE id = ?', run)).toEqual([
			{ status: 'assigned' }
		]);
	});
});

describe('listRuns project scope', () => {
	it('filters before the page limit so newer runs from another project cannot hide a focused run', async () => {
		const t = createTestDb();
		seedBase(t);
		t.sqlite
			.prepare(
				`INSERT INTO project (id, user_id, name, created_at, updated_at)
				 VALUES ('prj_other', ?, 'other', ?, ?)`
			)
			.run(USER, NOW, NOW);
		const runner = addRunner(t);
		const focusedIssue = addIssue(t, { project: PROJECT, id: 'iss_focused' });
		const otherIssue = addIssue(t, { project: 'prj_other', id: 'iss_other' });
		addRun(t, {
			id: 'run_focused',
			issueId: focusedIssue,
			runnerId: runner,
			createdAt: NOW - 1
		});
		for (let i = 0; i < 51; i++) {
			addRun(t, {
				id: `run_other_${String(i).padStart(2, '0')}`,
				issueId: otherIssue,
				runnerId: runner,
				createdAt: NOW + i
			});
		}

		const focused = await listRuns(t.db, USER, { projectId: PROJECT }, { cursor: null, limit: 50 });
		expect(focused.items.map((run) => run.id)).toEqual(['run_focused']);
		expect(focused.hasMore).toBe(false);

		const other = await listRuns(
			t.db,
			USER,
			{ projectId: 'prj_other' },
			{ cursor: null, limit: 50 }
		);
		expect(other.items).toHaveLength(50);
		expect(other.items.every((run) => run.issue_id === otherIssue)).toBe(true);
		expect(other.hasMore).toBe(true);
	});
});

describe('run continuation fields', () => {
	it('serializes lineage, local turn counts and fallback metadata without internal paths', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		addRun(t, { id: 'run_old', issueId: issue, runnerId: runner, createdAt: NOW - 1 });
		addRun(t, { id: 'run_new', issueId: issue, runnerId: runner, createdAt: NOW });
		t.sqlite
			.prepare(
				`UPDATE agent_run SET
			turn_count = 4, conversation_turn_count = 11, resumed_from_run_id = 'run_old',
			resume_expires_at = ?, workspace_path = '/private/workspace',
			resume_fallback_reason = 'unavailable'
			WHERE id = 'run_new'`
			)
			.run(NOW + 1000);

		const result = await listRuns(t.db, USER, { issue }, { cursor: null, limit: 50 });
		const run = result.items.find((item) => item.id === 'run_new');
		expect(run).toMatchObject({
			turn_count: 4,
			conversation_turn_count: 11,
			resumed_from_run_id: 'run_old',
			resume_expires_at: NOW + 1000,
			resume_fallback_reason: 'unavailable'
		});
		expect(JSON.stringify(run)).not.toContain('/private/workspace');
	});
});

describe('run pricing serialization', () => {
	it('preserves immutable nested evidence and decimal rate strings in list and detail reads', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		const usage = {
			input_tokens: 3,
			cache_read_tokens: 6,
			cache_write_tokens: 1,
			output_tokens: 1,
			cost_usd: 0.0000394,
			cost_source: 'priced',
			pricing: {
				version: 1,
				evaluated_at: NOW,
				status: 'calculated',
				evidence: { version: 1, model: 'gpt-5.6-sol', raw_usage: { input_tokens: 10 } },
				basis: {
					model: 'gpt-5.6-sol',
					rate_id: 'sol-v1',
					rates: {
						input_tokens: '4',
						cache_read_tokens: '0.4',
						cache_write_tokens: '5',
						output_tokens: '20'
					},
					cost_usd_exact: '0.0000394'
				}
			}
		};
		addRun(t, { id: 'run_priced', issueId: issue, runnerId: runner, usage: JSON.stringify(usage) });

		const listed = await listRuns(t.db, USER, { issue }, { cursor: null, limit: 50 });
		expect(listed.items[0]?.usage).toEqual(usage);
		expect((await getRun(t.db, USER, 'run_priced')).usage).toEqual(usage);
	});
});

describe('period usage evidence', () => {
	it('uses finalized end-time bounds and accounting filters before pagination', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		addRun(t, {
			id: 'before',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			endedAt: NOW - 1,
			usage: JSON.stringify({ cost_usd: 1 })
		});
		addRun(t, {
			id: 'at-from',
			issueId: issue,
			runnerId: runner,
			status: 'failed',
			endedAt: NOW,
			usage: JSON.stringify({ input_tokens: 0 })
		});
		addRun(t, {
			id: 'priced',
			issueId: issue,
			runnerId: runner,
			status: 'canceled',
			endedAt: NOW + 1,
			usage: JSON.stringify({ cost_usd: 0 })
		});
		addRun(t, {
			id: 'at-to',
			issueId: issue,
			runnerId: runner,
			status: 'timed_out',
			endedAt: NOW + 2,
			usage: JSON.stringify({ cost_usd: 2 })
		});
		const all = await listRuns(
			t.db,
			USER,
			{ population: 'finalized', from: NOW, to: NOW + 2 },
			{ cursor: null, limit: 10 }
		);
		expect(all.items.map((r) => r.id)).toEqual(['priced', 'at-from']);
		const priced = await listRuns(
			t.db,
			USER,
			{ population: 'finalized', from: NOW, to: NOW + 2, accountingStatus: 'priced' },
			{ cursor: null, limit: 10 }
		);
		expect(priced.items.map((r) => r.id)).toEqual(['priced']);
	});

	it('redacts facts learned after the pending cutoff', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		addRun(t, {
			id: 'later-ended',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			outcome: 'advanced',
			createdAt: NOW - 10,
			endedAt: NOW + 10,
			usage: JSON.stringify({ cost_usd: 42, cost_source: 'provider' })
		});
		const result = await listRuns(
			t.db,
			USER,
			{ population: 'pending', from: NOW - 100, to: NOW },
			{ cursor: null, limit: 10 }
		);
		expect(result.items).toEqual([
			expect.objectContaining({
				id: 'later-ended',
				pending_at: NOW,
				accounting_status: 'pending'
			})
		]);
		const wire = JSON.stringify(result.items[0]);
		for (const forbidden of ['usage', 'outcome', 'ended_at', 'status', 'error'])
			expect(wire).not.toContain(`"${forbidden}"`);
	});

	it('scans past sparse accounting misses without terminating pagination', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t);
		for (let i = 0; i < 1001; i++)
			addRun(t, {
				id: `unpriced_${i}`,
				issueId: issue,
				runnerId: runner,
				status: 'completed',
				endedAt: NOW + i,
				usage: JSON.stringify({ input_tokens: 1 })
			});
		addRun(t, {
			id: 'priced-oldest',
			issueId: issue,
			runnerId: runner,
			status: 'completed',
			endedAt: NOW - 1,
			usage: JSON.stringify({ cost_usd: 1.23, cost_source: 'provider' })
		});
		const result = await listRuns(
			t.db,
			USER,
			{
				population: 'finalized',
				from: NOW - 2,
				to: NOW + 2000,
				accountingStatus: 'priced'
			},
			{ cursor: null, limit: 10 }
		);
		expect(result.items.map((run) => run.id)).toEqual(['priced-oldest']);
		expect(result.hasMore).toBe(false);
	});
});
