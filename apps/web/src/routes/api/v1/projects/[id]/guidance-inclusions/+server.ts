import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { includeItem, listInclusions } from '$lib/server/api/guidance-inclusions';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const { items } = await listInclusions(db, env, actor, event.params.id);
	return json({ items, next_cursor: null });
});
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ item_id?: unknown }>(event);
	const { created, inclusion } = await includeItem(db, env, actor, event.params.id, body);
	return json(inclusion, { status: created ? 201 : 200 });
});
