import { expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import {
	seedBase,
	addTwoStageWorkflow,
	addIssue,
	addRun,
	addRunner,
	STAGE_A,
	STAGE_B,
	NOW,
	PROJECT,
	USER
} from '$lib/server/supervisor/test-fixtures';
import { load } from './+page.server';
it('keeps explicit board run scope and fleet reads independent, including one-shot rule links', async () => {
	const t = createTestDb();
	seedBase(t);
	addTwoStageWorkflow(t);
	const runner = addRunner(t);
	t.sqlite.exec(
		`INSERT INTO project(id,user_id,name,created_at,updated_at) VALUES('other','${USER}','other',${NOW},${NOW})`
	);
	const a = addIssue(t, { state: STAGE_A, workflow: 'wf_two', project: PROJECT });
	const b = addIssue(t, { state: STAGE_A, workflow: 'wf_two', project: 'other' });
	const c = addIssue(t, { state: STAGE_B, workflow: 'wf_two', project: PROJECT });
	const one = addRun(t, { issueId: a, runnerId: runner, stateAtStart: STAGE_A, status: 'running' });
	addRun(t, { issueId: b, runnerId: runner, stateAtStart: STAGE_A, status: 'running' });
	addRun(t, { issueId: c, runnerId: runner, stateAtStart: STAGE_B, status: 'running' });
	async function page(query: string) {
		return (await load({
			locals: { user: { id: USER } },
			platform: { env: t.env },
			url: new URL(`http://test/agents${query}`)
		} as unknown as Parameters<typeof load>[0])) as {
			runs: { id: string }[];
			fleetRuns: { id: string }[];
			boardProject: string | null;
		};
	}
	const filtered = await page(`?project=${PROJECT}&runs_state=${STAGE_A}`);
	expect(filtered.runs.map((r) => r.id)).toEqual([one]);
	expect(filtered.fleetRuns).toHaveLength(3);
	expect((await page(`?runs_state=${STAGE_A}`)).runs).toHaveLength(2);
	expect((await page(`?new=rule&project=${PROJECT}`)).boardProject).toBeNull();
	expect((await page(`?project=${PROJECT}`)).boardProject).toBe(PROJECT);
});
