import { json } from '@sveltejs/kit';
import type { TransitionIssueRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { transitionIssue } from '$lib/server/api/issues';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<TransitionIssueRequest>(event);
	return json(await transitionIssue(db, env, actor, event.params.id, body));
});
