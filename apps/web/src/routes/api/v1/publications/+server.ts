import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { listPublications } from '$lib/server/publications/publish';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const workflowId = event.url.searchParams.get('workflow') ?? undefined;
	return json({ items: await listPublications(db, env, actor, workflowId), next_cursor: null });
});
