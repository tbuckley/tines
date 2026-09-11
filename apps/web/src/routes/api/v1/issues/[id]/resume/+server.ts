import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { resumeIssue } from '$lib/server/api/issues';
import type { RequestHandler } from './$types';

/**
 * Un-park an issue. Run keys never reach this handler: the path is on the
 * control-plane fence (403 from auth) — an agent must not un-park itself.
 */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const issue = await resumeIssue(db, env, actor, event.params.id, effects);
	return json(issue);
});
