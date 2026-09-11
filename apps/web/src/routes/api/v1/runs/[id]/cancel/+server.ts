import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { cancelRunForRequest } from '$lib/server/api/runs';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	return json(await cancelRunForRequest(db, env, actor, effects, event.params.id));
});
