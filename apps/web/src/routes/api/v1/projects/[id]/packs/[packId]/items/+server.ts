import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { createPackItem, moveItemIntoPack } from '$lib/server/api/packs/authoring';
import type { CreatePackItemRequest } from '@tines/shared';
import type { RequestHandler } from './$types';

/** Adds a context item to the (authored) pack, or `{ move_item_id }` moves a project item in. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<CreatePackItemRequest & { move_item_id?: string }>(event);
	const detail =
		typeof body.move_item_id === 'string'
			? await moveItemIntoPack(
					db,
					env,
					actor,
					event.params.id,
					event.params.packId,
					body.move_item_id
				)
			: await createPackItem(db, env, actor, event.params.id, event.params.packId, body);
	return json(detail, { status: 201 });
});
