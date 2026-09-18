import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { getPublicationResult } from '$lib/server/publications/publish';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getPublicationResult(db, actor, event.params.candidateId));
});
