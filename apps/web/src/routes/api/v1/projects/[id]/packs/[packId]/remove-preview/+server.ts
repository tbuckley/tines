import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { removePreview } from '$lib/server/api/packs/authoring';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await removePreview(db, actor, event.params.id, event.params.packId));
});
