import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { setPackItemBinding } from '$lib/server/api/packs/authoring';
import type { UpdatePackItemBindingRequest } from '@tines/shared';
import type { RequestHandler } from './$types';

/** Binds an authored pack's env or repo item to an input, or to a fixed value. */
export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdatePackItemBindingRequest>(event);
	return json(
		await setPackItemBinding(
			db,
			env,
			actor,
			event.params.id,
			event.params.packId,
			event.params.itemId,
			body
		)
	);
});
