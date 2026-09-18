import { json } from '@sveltejs/kit';
import { api, apiContext, readPage } from '$lib/server/api/core';
import { getPublisherSuspension, listPublications } from '$lib/server/publications/publish';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const workflowId = event.url.searchParams.get('workflow') ?? undefined;
	const [items, suspension] = await Promise.all([
		listPublications(db, env, actor, {
			workflowId,
			page: readPage(event, { defaultLimit: 100 })
		}),
		getPublisherSuspension(db, actor)
	]);
	return json({ ...items, suspension });
});
