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
import { listRuns } from './runs';

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
