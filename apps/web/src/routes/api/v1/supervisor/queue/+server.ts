import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { loadFleetQueue } from '$lib/server/api/supervisor';
import type { RequestHandler } from './$types';

/**
 * The fleet's waiting work, grouped by why it is waiting. Readable with a run
 * key: it discloses no more than the per-issue dispatch explainer agents
 * already have, and an agent asking "why is nothing moving?" should be able
 * to see the answer (Tines/256).
 */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await loadFleetQueue(db, actor.userId));
});
