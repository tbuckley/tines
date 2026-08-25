import { json } from '@sveltejs/kit';
import { effectiveContextForIssue } from '$lib/server/api/context';
import { api, apiContext } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

/** Effective context: the assembled bundle for the issue, computed on read. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await effectiveContextForIssue(db, actor.userId, event.params.id));
});
