import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { excludeItem } from '$lib/server/api/guidance-inclusions';
import type { RequestHandler } from './$types';
export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	return json(await excludeItem(db, env, actor, event.params.id, event.params.itemId));
});
