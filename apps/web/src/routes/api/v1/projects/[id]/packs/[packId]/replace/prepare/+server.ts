import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { prepareReplace, prepareUpdateFromSource } from '$lib/server/api/packs/install';
import type { RequestHandler } from './$types';

/** Reviews a new version (an upload, or `from_source: true`) for Replace. Writes nothing. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ from_source?: boolean }>(event);
	return json(
		body.from_source === true
			? await prepareUpdateFromSource(db, env, actor, event.params.id, event.params.packId)
			: await prepareReplace(db, actor, event.params.id, event.params.packId, body)
	);
});
