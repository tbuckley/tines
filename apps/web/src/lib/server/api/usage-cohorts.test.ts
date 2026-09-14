import { describe, expect, it } from 'vitest';
import {
	addIssue,
	addRun,
	addRunner,
	CLOSED,
	NOW,
	OPEN,
	PROJECT,
	seedBase,
	USER
} from '../supervisor/test-fixtures';
import { createTestDb } from './test-db';
import { getCohortUsage } from './usage-cohorts';

function entry(
	t: ReturnType<typeof createTestDb>,
	id: string,
	issue: string,
	at: number,
	state: string,
	category: 'active' | 'done'
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
			issue,
			PROJECT,
			JSON.stringify({
				state_entry_version: 1,
				workflow_id: 'wf_standard',
				workflow_name: 'Engineering',
				to_state_id: state,
				to_state_name: category === 'done' ? 'Closed' : 'Backlog',
				to_state_category: category
			}),
			at
		);
}

describe('completion cohort usage', () => {
	it('deduplicates latest completion entries and includes no-run issues in all-issue means', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const priced = addIssue(t, { id: 'iss_priced', state: CLOSED });
		const noRun = addIssue(t, { id: 'iss_no_run', state: CLOSED });
		entry(t, 'evt_done_1', priced, NOW - 80, CLOSED, 'done');
		entry(t, 'evt_done_2', priced, NOW - 60, CLOSED, 'done');
		entry(t, 'evt_done_3', noRun, NOW - 50, CLOSED, 'done');
		entry(t, 'evt_reopen', priced, NOW - 20, OPEN, 'active');
		addRun(t, {
			issueId: priced,
			runnerId: runner,
			createdAt: NOW - 1_000,
			endedAt: NOW - 40,
			usage: JSON.stringify({ cost_usd: 4, cost_source: 'provider' })
		});
		addRun(t, {
			issueId: priced,
			runnerId: runner,
			createdAt: NOW - 30,
			endedAt: NOW + 10,
			usage: JSON.stringify({ cost_usd: 99, cost_source: 'provider' })
		});

		const report = await getCohortUsage(
			t.db,
			USER,
			{
				workflow: 'wf_standard',
				from: new Date(NOW - 100).toISOString(),
				to: new Date(NOW).toISOString()
			},
			NOW + 100
		);

		expect(report).toMatchObject({
			selection_basis: 'all_current_done',
			aggregate: { cost_usd_exact: '4', finalized_run_count: 1 },
			counters: {
				distinct_issue_count: 2,
				attempt_count: 2,
				pending_count: 1,
				zero_run_issue_count: 1,
				fully_priced_issue_count: 0,
				reopened_issue_count: 1,
				mean_attempts_per_issue: { numerator: 2, denominator: 2, value: 1 },
				known_cost_per_issue: {
					numerator_usd_exact: '4',
					denominator: 2,
					value_usd: 2,
					coverage: 'partial'
				}
			}
		});
	});

	it('excludes completions before the half-open window and at its exclusive end', async () => {
		const t = createTestDb();
		seedBase(t);
		const before = addIssue(t, { id: 'iss_before' });
		const boundary = addIssue(t, { id: 'iss_boundary' });
		entry(t, 'evt_before', before, NOW - 101, CLOSED, 'done');
		entry(t, 'evt_boundary', boundary, NOW, CLOSED, 'done');

		const report = await getCohortUsage(
			t.db,
			USER,
			{
				workflow: 'wf_standard',
				from: new Date(NOW - 100).toISOString(),
				to: new Date(NOW).toISOString()
			},
			NOW + 100
		);
		expect(report?.counters.distinct_issue_count).toBe(0);
		expect(report?.counters.known_cost_per_issue.coverage).toBe('empty');
	});

	it('uses the recorded entry project rather than the issue current project', async () => {
		const t = createTestDb();
		seedBase(t);
		t.sqlite
			.prepare('INSERT INTO project (id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)')
			.run('prj_recorded_elsewhere', USER, 'Elsewhere', NOW, NOW);
		const issue = addIssue(t, { id: 'iss_moved_after_completion', state: CLOSED });
		entry(t, 'evt_other_project', issue, NOW - 20, CLOSED, 'done');
		t.sqlite
			.prepare('UPDATE event SET project_id=? WHERE id=?')
			.run('prj_recorded_elsewhere', 'evt_other_project');

		const report = await getCohortUsage(
			t.db,
			USER,
			{
				workflow: 'wf_standard',
				project: PROJECT,
				from: new Date(NOW - 100).toISOString(),
				to: new Date(NOW).toISOString()
			},
			NOW + 100
		);

		expect(report?.counters.distinct_issue_count).toBe(0);
		expect(report?.history.qualifying_fact_count).toBe(0);
	});

	it('does not claim a retained event whose current issue identity belongs to another account', async () => {
		const t = createTestDb();
		seedBase(t);
		t.sqlite.exec(`
			INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt)
			VALUES ('u_foreign','bob','b@example.com',1,${NOW},${NOW});
			INSERT INTO project (id,user_id,name,created_at,updated_at)
			VALUES ('prj_foreign','u_foreign','private',${NOW},${NOW});
		`);
		const foreign = addIssue(t, { id: 'iss_foreign_cohort', project: 'prj_foreign' });
		entry(t, 'evt_owned_foreign_identity', foreign, NOW - 20, CLOSED, 'done');

		const report = await getCohortUsage(
			t.db,
			USER,
			{
				workflow: 'wf_standard',
				from: new Date(NOW - 100).toISOString(),
				to: new Date(NOW).toISOString()
			},
			NOW + 100
		);

		expect(report?.counters.distinct_issue_count).toBe(0);
		expect(report?.aggregate.finalized_run_count).toBe(0);
	});

	it('does not authorize a live foreign workflow from retained owner event metadata', async () => {
		const t = createTestDb();
		seedBase(t);
		const issue = addIssue(t, { id: 'iss_owned_foreign_workflow' });
		t.sqlite.exec(`
			INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt)
			VALUES ('u_foreign_workflow','bob','wf@example.com',1,${NOW},${NOW});
			INSERT INTO workflow (id,user_id,name,initial_state_id,created_at,updated_at)
			VALUES ('wf_foreign','u_foreign_workflow','Private workflow','${OPEN}',${NOW},${NOW});
		`);
		t.sqlite
			.prepare(
				`INSERT INTO event (id,user_id,type,actor_user_id,issue_id,project_id,payload,created_at)
				 VALUES (?,?,?,?,?,?,?,?)`
			)
			.run(
				'evt_foreign_workflow_claim',
				USER,
				'issue.transitioned',
				USER,
				issue,
				PROJECT,
				JSON.stringify({
					state_entry_version: 1,
					workflow_id: 'wf_foreign',
					workflow_name: 'Private workflow',
					to_state_id: 'st_foreign_done',
					to_state_name: 'Private done',
					to_state_category: 'done'
				}),
				NOW - 20
			);

		const report = await getCohortUsage(
			t.db,
			USER,
			{
				workflow: 'wf_foreign',
				from: new Date(NOW - 100).toISOString(),
				to: new Date(NOW).toISOString()
			},
			NOW + 100
		);

		expect(report).toBeNull();
	});

	it('carries one member across the 5,000-row tuple boundary without a duplicate sentinel', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t);
		const issue = addIssue(t, { id: 'iss_large_cohort', state: CLOSED });
		entry(t, 'evt_large_cohort', issue, NOW - 90, CLOSED, 'done');
		for (let index = 0; index < 5_002; index++)
			addRun(t, {
				id: `arun_large_${String(index).padStart(5, '0')}`,
				issueId: issue,
				runnerId: runner,
				status: 'completed',
				createdAt: NOW - 80,
				endedAt: NOW - 70,
				usage: JSON.stringify({ cost_usd: 1, cost_source: 'provider' })
			});

		const report = await getCohortUsage(
			t.db,
			USER,
			{
				workflow: 'wf_standard',
				from: new Date(NOW - 100).toISOString(),
				to: new Date(NOW).toISOString()
			},
			NOW + 100
		);

		expect(report).toMatchObject({
			aggregate: { finalized_run_count: 5_002, cost_usd_exact: '5002' },
			counters: { distinct_issue_count: 1, attempt_count: 5_002, zero_run_issue_count: 0 }
		});
	}, 20_000);
});
