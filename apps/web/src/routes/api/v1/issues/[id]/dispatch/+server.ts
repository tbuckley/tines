import { json } from '@sveltejs/kit';
import { api, apiContext, notFound } from '$lib/server/api/core';
import { explainDispatch } from '$lib/server/supervisor/explain';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const explainer = await explainDispatch(db, actor.userId, event.params.id);
	if (!explainer) throw notFound();
	return json(explainer);
});
