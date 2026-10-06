import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { listSourceCandidates } from '$lib/server/api/packs/install';
import type { RequestHandler } from './$types';

/** Packs in other projects the caller can read: install sources. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const items = await listSourceCandidates(db, actor, event.url.searchParams.get('project'));
	return json({ items, next_cursor: null });
});
