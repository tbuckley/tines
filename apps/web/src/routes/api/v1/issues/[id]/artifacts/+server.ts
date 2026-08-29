import { json } from '@sveltejs/kit';
import type { ArtifactListResponse } from '@tines/shared';
import { listArtifacts } from '$lib/server/api/artifacts';
import { api, apiContext } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const body: ArtifactListResponse = { items: await listArtifacts(db, actor.userId, event.params.id) };
	return json(body);
});
