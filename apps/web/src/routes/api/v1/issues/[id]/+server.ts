import { json } from '@sveltejs/kit';
import type { UpdateIssueRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { getIssueDetail, updateIssue } from '$lib/server/api/issues';
import { queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getIssueDetail(db, actor.userId, { id: event.params.id }, { round: true }));
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdateIssueRequest>(event);
	const issue = await updateIssue(db, env, actor, event.params.id, body);
	// A forced state set or a pin change can make the issue dispatchable.
	queueDispatchPass(event.platform, actor.userId);
	return json(issue);
});
