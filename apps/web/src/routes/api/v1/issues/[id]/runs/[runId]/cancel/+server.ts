import { json } from '@sveltejs/kit';
import { api, apiContext, notFound, readOptionalJson } from '$lib/server/api/core';
import { cancelRunForRequest } from '$lib/server/api/runs';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	await readOptionalJson(event);
	const attached = await db
		.selectFrom('agent_run as ar')
		.innerJoin('issue as i', 'i.id', 'ar.issue_id')
		.innerJoin('project as p', 'p.id', 'i.project_id')
		.select('ar.id')
		.where('ar.id', '=', event.params.runId)
		.where('ar.issue_id', '=', event.params.id)
		.where('p.user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!attached) throw notFound();
	return json(await cancelRunForRequest(db, env, actor, effects, event.params.runId));
});
