import { describe, expect, it } from 'vitest';
import { addIssue, addRun, addRunner, NOW, seedBase, USER } from '../supervisor/test-fixtures';
import { createTestDb } from './test-db';
import { authorizeUsageFilters } from './usage-ledger';

describe('retained usage identity authorization', () => {
	it('checks multiple missing identities in one account-fenced aggregate scan', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t, { id: 'rnr_deleted' });
		const issue = addIssue(t, { id: 'iss_retained' });
		addRun(t, { id: 'run_retained', issueId: issue, runnerId: runner, endedAt: NOW - 1 });
		t.sqlite.exec(`
			PRAGMA foreign_keys = OFF;
			DELETE FROM runner WHERE id = 'rnr_deleted';
			DELETE FROM project WHERE id = 'prj_1';
			PRAGMA foreign_keys = ON;
		`);
		const queries = t.spyOnQueries();

		expect(
			await authorizeUsageFilters(t.db, USER, {
				project: 'prj_1',
				runner: 'rnr_deleted'
			})
		).toBe(true);
		const retainedScans = queries().filter((query) => query.includes('MAX(CASE WHEN'));
		expect(retainedScans).toHaveLength(1);
		expect(retainedScans[0]).toContain('"agent_run"."user_id" = ?');
		expect(retainedScans[0]).toContain('issue.project_id = ?');
		expect(retainedScans[0]).toContain('agent_run.runner_id = ?');
	});

	it('does not authorize an identity retained only by another account', async () => {
		const t = createTestDb();
		seedBase(t);
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
				VALUES ('u2', 'bob', 'b@example.com', 1, ${NOW}, ${NOW});
			INSERT INTO project (id, user_id, name, created_at, updated_at)
				VALUES ('prj_foreign', 'u2', 'foreign', ${NOW}, ${NOW});
			INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id,
				attempt_count, needs_attention, created_at, updated_at, state_entered_at)
				VALUES ('iss_foreign', 'prj_foreign', 1, 'foreign', '', 'wf_standard',
				'wfs_std_open', 0, 0, ${NOW}, ${NOW}, ${NOW});
			INSERT INTO runner (id, user_id, type, name, status, max_concurrent, max_run_minutes,
				default_tier, config, last_seen_at, launch_failures, draining, created_at, updated_at)
				VALUES ('rnr_foreign', 'u2', 'local', 'foreign', 'active', 1, 30, 'balanced',
				'{}', ${NOW}, 0, 0, ${NOW}, ${NOW});
			INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, tier, state_id_at_start,
				log, created_at, ended_at)
				VALUES ('run_foreign', 'u2', 'iss_foreign', 'rnr_foreign', 'completed', 'balanced',
				'wfs_std_open', '', ${NOW - 1}, ${NOW});
		`);

		expect(
			await authorizeUsageFilters(t.db, USER, {
				project: 'prj_foreign',
				runner: 'rnr_foreign'
			})
		).toBe(false);
	});
});
