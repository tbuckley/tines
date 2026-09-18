import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { buildLibraryV3Document } from '$lib/server/api/library-v3-export';
import { buildLibraryDocument } from '$lib/server/api/library';
import type { RequestHandler } from './$types';

/**
 * The whole reusable library as one portable document. Read-only, and
 * strictly a re-shaping of what `GET /workflows` and `GET /context` already
 * return — so it stays run-key legal, unlike its import counterpart.
 */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const includeJournals = event.url.searchParams.get('journals') !== 'false';
	const doc = await (
		event.url.searchParams.get('version') === '2' ? buildLibraryDocument : buildLibraryV3Document
	)(db, actor.userId, { includeJournals });
	return json(doc);
});
