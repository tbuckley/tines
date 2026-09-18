import { expect, it } from 'vitest';
import { addIssue, addRunner, NOW, seedBase, USER } from '../supervisor/test-fixtures';
import { createTestDb } from './test-db';
import { getUsage } from './usage';
import { listRuns } from './runs';

it('seeks across large timestamp ties without losing period bounds or evidence rows', async () => {
	const t = createTestDb();
	seedBase(t);
	const runner = addRunner(t);
	const issue = addIssue(t);
	t.sqlite
		.prepare(
			`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<10003)
		INSERT INTO agent_run (id,user_id,issue_id,runner_id,status,tier,log,state_id_at_start,usage,created_at,ended_at)
		SELECT printf('tie_%05d',n),?,?,?,'completed','balanced','','wfs_std_open',
		CASE WHEN n=1 THEN '{"cost_usd":1,"cost_source":"provider"}' ELSE NULL END,
		?, CASE WHEN n=10002 THEN ? WHEN n=10003 THEN ? ELSE ? END FROM seq`
		)
		.run(USER, issue, runner, NOW - 3000, NOW, NOW - 2001, NOW - 1000);
	const from = NOW - 2000;
	const to = NOW;
	const report = await getUsage(t.db, USER, {
		from: new Date(from).toISOString(),
		to: new Date(to).toISOString()
	});
	expect(report.scope_total).toMatchObject({
		finalized_run_count: 10001,
		priced_run_count: 1,
		cost_usd: 1
	});
	const sparse = await listRuns(
		t.db,
		USER,
		{ population: 'finalized', from, to, accountingStatus: 'priced' },
		{ cursor: null, limit: 1 }
	);
	expect(sparse.items.map((item) => item.id)).toEqual(['tie_00001']);
	expect(sparse.hasMore).toBe(false);
	const first = await listRuns(
		t.db,
		USER,
		{ population: 'finalized', from, to },
		{ cursor: null, limit: 2 }
	);
	expect(first.items.map((item) => item.id)).toEqual(['tie_10001', 'tie_10000']);
	const second = await listRuns(
		t.db,
		USER,
		{ population: 'finalized', from, to },
		{ cursor: first.nextBoundary, limit: 2 }
	);
	expect(second.items.map((item) => item.id)).toEqual(['tie_09999', 'tie_09998']);
	// Pending uses created_at for its seek, while retaining the end-at-cutoff predicate.
	const pending = await listRuns(
		t.db,
		USER,
		{ population: 'pending', to },
		{ cursor: null, limit: 1 }
	);
	expect(pending.items.map((item) => item.id)).toEqual(['tie_10002']);
	expect(pending.hasMore).toBe(false);
});
