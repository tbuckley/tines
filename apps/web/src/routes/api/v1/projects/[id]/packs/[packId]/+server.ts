import { json } from '@sveltejs/kit';
import { api, apiContext, readJson, readOptionalJson } from '$lib/server/api/core';
import { getPack, removePack, updatePack } from '$lib/server/api/packs/authoring';
import type { UpdatePackRequest } from '@tines/shared';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getPack(db, actor, event.params.id, event.params.packId));
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdatePackRequest>(event);
	return json(await updatePack(db, env, actor, event.params.id, event.params.packId, body));
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readOptionalJson<{ expected_revision?: number }>(event);
	return json(await removePack(db, env, actor, event.params.id, event.params.packId, body));
});
