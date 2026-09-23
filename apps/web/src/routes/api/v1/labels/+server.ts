import { json } from '@sveltejs/kit';
import type { CreateLabelRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { createLabel, listLabels } from '$lib/server/api/labels';
import type { RequestHandler } from './$types';

/** The whole library; a user's label vocabulary is small enough not to page. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json({ items: await listLabels(db, actor) });
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<CreateLabelRequest>(event);
	return json(await createLabel(db, env, actor, body), { status: 201 });
});
