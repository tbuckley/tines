import { api, apiContext } from '$lib/server/api/core';
import { removeIssueLink } from '$lib/server/api/issue-links';
import { actorForIssue } from '$lib/server/api/project-access';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor: requester, effects } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	await removeIssueLink(db, env, actor, effects, event.params.id, event.params.linkId);
	return new Response(null, { status: 204 });
});
