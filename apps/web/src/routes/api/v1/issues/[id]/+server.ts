import { json } from '@sveltejs/kit';
import type { UpdateIssueRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { getIssueDetailForActor, updateIssue } from '$lib/server/api/issues';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getIssueDetailForActor(db, actor, { id: event.params.id }, { round: true }));
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const body = await readJson<UpdateIssueRequest>(event);
	const issue = await updateIssue(db, env, actor, effects, event.params.id, body);
	return json(issue);
});
