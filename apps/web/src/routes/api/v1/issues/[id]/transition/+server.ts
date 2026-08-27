import { json } from '@sveltejs/kit';
import type { TransitionIssueRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { transitionIssue } from '$lib/server/api/issues';
import { queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<TransitionIssueRequest>(event);
	const issue = await transitionIssue(db, env, actor, event.params.id, body);
	// A transition can make the issue (or, by un-parking, others) eligible.
	queueDispatchPass(event.platform, actor.userId);
	return json(issue);
});
