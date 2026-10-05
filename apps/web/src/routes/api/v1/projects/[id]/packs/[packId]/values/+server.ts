import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { setPackValues } from '$lib/server/api/packs/authoring';
import type { PackInputValueInput } from '@tines/shared';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ values?: Record<string, PackInputValueInput | null> }>(event);
	return json(await setPackValues(db, env, actor, event.params.id, event.params.packId, body));
});
