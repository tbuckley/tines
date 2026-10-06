import { json } from '@sveltejs/kit';
import { api, apiContext, readOptionalJson } from '$lib/server/api/core';
import { detachPack } from '$lib/server/api/packs/authoring';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readOptionalJson<{ expected_revision?: number }>(event);
	return json(await detachPack(db, env, actor, event.params.id, event.params.packId, body));
});
