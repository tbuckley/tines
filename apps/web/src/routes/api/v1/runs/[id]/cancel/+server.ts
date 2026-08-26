import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { assertCancelable, getRun } from '$lib/server/api/runs';
import { cancelRun, queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const result = await cancelRun(env, actor.userId, event.params.id);
	assertCancelable(result.kind);
	// A run end frees capacity: the freed slot can dispatch in seconds.
	queueDispatchPass(event.platform, actor.userId);
	return json(await getRun(db, actor.userId, event.params.id));
});
