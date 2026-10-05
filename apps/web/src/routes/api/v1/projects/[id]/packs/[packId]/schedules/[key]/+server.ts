import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { removePackSuggestion } from '$lib/server/api/packs/authoring';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	return json(
		await removePackSuggestion(
			db,
			env,
			actor,
			event.params.id,
			event.params.packId,
			event.params.key
		)
	);
});
