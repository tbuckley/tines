import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { archiveProject } from '$lib/server/api/projects';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	return json(await archiveProject(db, env, actor, event.params.id));
});
