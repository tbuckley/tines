import { api, apiContext } from '$lib/server/api/core';
import { removeIssueLabel } from '$lib/server/api/labels';
import { actorForIssue } from '$lib/server/api/project-access';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor: requester, effects } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	await removeIssueLabel(db, env, actor, effects, event.params.id, event.params.labelRef);
	return new Response(null, { status: 204 });
});
