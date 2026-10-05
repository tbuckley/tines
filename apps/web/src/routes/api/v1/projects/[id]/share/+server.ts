import { json } from '@sveltejs/kit';
import { api, apiContext, readOptionalJson } from '$lib/server/api/core';
import { shareProject } from '$lib/server/api/org-move';
import type { ShareProjectRequest } from '@tines/shared';
import type { RequestHandler } from './$types';

/** Share this project: a new shared organization, with the project moved into it. Browser only. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readOptionalJson<ShareProjectRequest>(event);
	return json(await shareProject(db, env, actor, event.params.id, body), { status: 201 });
});
