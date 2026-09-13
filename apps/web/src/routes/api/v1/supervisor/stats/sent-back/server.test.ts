import { expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import {
	seedBase,
	addTwoStageWorkflow,
	addIssue,
	addTransitionEvent,
	STAGE_A,
	STAGE_B,
	NOW,
	USER
} from '$lib/server/supervisor/test-fixtures';
import { GET } from './+server';
it('passes frozen evidence bounds through the route and rejects invalid inputs', async () => {
	const t = createTestDb();
	seedBase(t);
	addTwoStageWorkflow(t);
	const issue = addIssue(t, { state: STAGE_A, workflow: 'wf_two' });
	const until = NOW - 86400000;
	addTransitionEvent(t, { issueId: issue, at: until, from: STAGE_B, to: STAGE_A, apiKeyId: null });
	const get = (suffix: string) => {
		const url = new URL(`http://test/api/v1/supervisor/stats/sent-back?state=${STAGE_B}${suffix}`);
		return GET({
			locals: { user: { id: USER, name: 'alice' } },
			platform: { env: t.env, ctx: { waitUntil: () => {} } },
			request: new Request(url),
			url
		} as unknown as Parameters<typeof GET>[0]);
	};
	const frozen = await get(`&until=${until}`);
	expect(frozen.status).toBe(200);
	expect(await frozen.json()).toMatchObject({ window: { until }, items: [] });
	const later = await get(`&until=${until + 1}`);
	expect((await later.json()).items).toHaveLength(1);
	for (const invalid of ['', 'nan', 'Infinity', '-1', '1.5', String(Date.now() + 86400000)])
		expect((await get(`&until=${invalid}`)).status).toBe(422);
});
