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
