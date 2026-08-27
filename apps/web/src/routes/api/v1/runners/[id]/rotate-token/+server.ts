import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { rotateRunnerToken } from '$lib/server/api/runners';
import type { RequestHandler } from './$types';

/**
 * Re-mint a local runner's token in place: the old token is invalidated
 * (the daemon's next poll 401s until it adopts the new one), the runner
 * row, history, and rule references are untouched. User auth only — run
 * keys are fenced off `/runners*`, and runner tokens cannot call outside
 * the protocol endpoints.
 */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	return json(await rotateRunnerToken(db, env, actor, event.params.id));
});
