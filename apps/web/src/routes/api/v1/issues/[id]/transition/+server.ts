import { json } from '@sveltejs/kit';
import type { TransitionIssueRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { transitionIssue } from '$lib/server/api/issues';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const body = await readJson<TransitionIssueRequest>(event);
	const issue = await transitionIssue(db, env, actor, effects, event.params.id, body);
	return json(issue);
});
