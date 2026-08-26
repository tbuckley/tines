import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { getRun } from '$lib/server/api/runs';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getRun(db, actor.userId, event.params.id));
});
