import { api, apiContext } from '$lib/server/api/core';
import { removeIssueLink } from '$lib/server/api/issue-links';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	await removeIssueLink(db, env, actor, event.params.id, event.params.linkId, effects);
	return new Response(null, { status: 204 });
});
