import { json } from '@sveltejs/kit';
import type { ArtifactListResponse } from '@tines/shared';
import { actorForIssue } from '$lib/server/api/project-access';
import { listArtifactsForActor } from '$lib/server/api/artifacts';
import { api, apiContext } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor: requester } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	const body: ArtifactListResponse = {
		items: await listArtifactsForActor(db, actor, event.params.id)
	};
	return json(body);
});
