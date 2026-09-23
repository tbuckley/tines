import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { createStateRetirementInventory } from '$lib/server/state-retirement/inventory';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await createStateRetirementInventory(db, actor));
});
