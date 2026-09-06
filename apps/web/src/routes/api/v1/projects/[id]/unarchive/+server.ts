import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { unarchiveProject } from '$lib/server/api/projects';
import { queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const result = await unarchiveProject(db, env, actor, event.params.id);
	// Issues that were held back while the project was archived become
	// eligible again; pick them up now rather than at the next tick.
	queueDispatchPass(event.platform, actor.userId);
	return json(result);
});
