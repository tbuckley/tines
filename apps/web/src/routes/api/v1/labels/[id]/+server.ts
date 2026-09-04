import { json } from '@sveltejs/kit';
import type { UpdateLabelRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { deleteLabel, updateLabel } from '$lib/server/api/labels';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdateLabelRequest>(event);
	return json(await updateLabel(db, env, actor, event.params.id, body));
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	return json(await deleteLabel(db, env, actor, event.params.id));
});
