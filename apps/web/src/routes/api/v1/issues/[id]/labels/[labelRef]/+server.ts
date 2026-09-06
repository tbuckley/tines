import { api, apiContext } from '$lib/server/api/core';
import { removeIssueLabel } from '$lib/server/api/labels';
import { queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	await removeIssueLabel(db, env, actor, event.params.id, event.params.labelRef);
	// A label is a routing-rule dimension, so losing one can remove a match.
	queueDispatchPass(event.platform, actor.userId);
	return new Response(null, { status: 204 });
});
