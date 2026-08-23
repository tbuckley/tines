import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { getIssueDetail } from '$lib/server/api/issues';
import { runScheduleNow } from '$lib/server/api/schedules';
import type { RequestHandler } from './$types';

/** Run now: create an instance immediately (gate-respecting; 422 when blocked). */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const issueId = await runScheduleNow(db, env, actor, event.params.id);
	return json(await getIssueDetail(db, actor.userId, { id: issueId }), { status: 201 });
});
