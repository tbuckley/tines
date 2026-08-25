import { json } from '@sveltejs/kit';
import type { UpdateContextItemRequest } from '@tines/shared';
import { deleteContextItem, getContextItem, updateContextItem } from '$lib/server/api/context';
import { api, apiContext, readJson } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getContextItem(db, actor.userId, event.params.id));
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdateContextItemRequest>(event);
	return json(await updateContextItem(db, env, actor, event.params.id, body));
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	await deleteContextItem(db, env, actor, event.params.id);
	return new Response(null, { status: 204 });
});
