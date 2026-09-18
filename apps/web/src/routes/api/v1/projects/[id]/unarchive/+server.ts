import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { unarchiveProject } from '$lib/server/api/projects';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const result = await unarchiveProject(db, env, actor, effects, event.params.id);
	return json(result);
});
