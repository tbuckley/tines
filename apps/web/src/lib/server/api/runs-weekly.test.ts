import { expect, it } from 'vitest';
import { createTestDb } from './test-db';
import { listRuns } from './runs';
import {
	addIssue,
	addRun,
	addRunner,
	addTwoStageWorkflow,
	NOW,
	PROJECT,
	seedBase,
	STAGE_A,
	STAGE_B,
	USER
} from '../supervisor/test-fixtures';
it('applies state and project together before limiting without shrinking fleet reads', async () => {
	const t = createTestDb();
	seedBase(t);
	addTwoStageWorkflow(t);
	const runner = addRunner(t);
	t.sqlite.exec(
		`INSERT INTO project(id,user_id,name,created_at,updated_at) VALUES('other','${USER}','other',${NOW},${NOW})`
	);
	const wanted = addIssue(t, { project: PROJECT, state: STAGE_A, workflow: 'wf_two' });
	const wrongProject = addIssue(t, { project: 'other', state: STAGE_A, workflow: 'wf_two' });
	const wrongState = addIssue(t, { project: PROJECT, state: STAGE_B, workflow: 'wf_two' });
	const run = addRun(t, {
		issueId: wanted,
		runnerId: runner,
		stateAtStart: STAGE_A,
		status: 'running',
		createdAt: NOW - 100
	});
	addRun(t, {
		issueId: wrongProject,
		runnerId: runner,
		stateAtStart: STAGE_A,
		status: 'running',
		createdAt: NOW
	});
	addRun(t, {
		issueId: wrongState,
		runnerId: runner,
		stateAtStart: STAGE_B,
		status: 'running',
		createdAt: NOW
	});
	const selected = await listRuns(
		t.db,
		USER,
		{ state: STAGE_A, projectId: PROJECT },
		{ cursor: null, limit: 1 }
	);
	expect(selected.items.map((r) => r.id)).toEqual([run]);
	expect(selected.hasMore).toBe(false);
	expect(
		(await listRuns(t.db, USER, { active: true }, { cursor: null, limit: 50 })).items
	).toHaveLength(3);
});
