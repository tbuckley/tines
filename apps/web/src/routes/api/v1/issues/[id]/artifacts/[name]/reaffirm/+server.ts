import { json } from '@sveltejs/kit';
import { reaffirmArtifact } from '$lib/server/api/artifacts';
import { api, apiContext } from '$lib/server/api/core';
import { actorForIssue } from '$lib/server/api/project-access';
import type { RequestHandler } from './$types';

/** "This artifact still stands": appends a version reusing the current payload. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	return json(await reaffirmArtifact(db, env, actor, event.params.id, event.params.name));
});
