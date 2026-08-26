import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { resumeIssue } from '$lib/server/api/issues';
import { queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

/**
 * Un-park an issue. Run keys never reach this handler: the path is on the
 * control-plane fence (403 from auth) — an agent must not un-park itself.
 */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const issue = await resumeIssue(db, env, actor, event.params.id);
	queueDispatchPass(event.platform, actor.userId);
	return json(issue);
});
