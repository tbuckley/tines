import { json } from '@sveltejs/kit';
import type { AddIssueLabelsRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { addIssueLabels } from '$lib/server/api/labels';
import { actorForIssue } from '$lib/server/api/project-access';
import type { RequestHandler } from './$types';

/** Incremental add, never a set-replace: concurrent edits both survive. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor: requester, effects } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	const body = await readJson<AddIssueLabelsRequest>(event);
	const result = await addIssueLabels(db, env, actor, effects, event.params.id, body.labels);
	return json(result);
});
