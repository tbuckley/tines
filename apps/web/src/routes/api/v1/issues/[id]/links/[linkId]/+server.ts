import { api, apiContext } from '$lib/server/api/core';
import { removeIssueLink } from '$lib/server/api/issue-links';
import { queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	await removeIssueLink(db, env, actor, event.params.id, event.params.linkId);
	// Removing a blocker or duplicate link can restore readiness.
	queueDispatchPass(event.platform, actor.userId);
	return new Response(null, { status: 204 });
});
