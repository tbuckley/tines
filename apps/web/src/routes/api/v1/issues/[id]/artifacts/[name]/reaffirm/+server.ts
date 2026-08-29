import { json } from '@sveltejs/kit';
import { reaffirmArtifact } from '$lib/server/api/artifacts';
import { api, apiContext } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

/** "This artifact still stands": appends a version reusing the current payload. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	return json(await reaffirmArtifact(db, env, actor, event.params.id, event.params.name));
});
