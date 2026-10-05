import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { replacePack, updateFromSource } from '$lib/server/api/packs/install';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ from_source?: boolean }>(event);
	return json(
		body.from_source === true
			? await updateFromSource(db, env, actor, event.params.id, event.params.packId, body)
			: await replacePack(db, env, actor, event.params.id, event.params.packId, body)
	);
});
