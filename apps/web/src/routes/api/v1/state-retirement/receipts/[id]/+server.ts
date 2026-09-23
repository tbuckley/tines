import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { getStateRetirementReceipt } from '$lib/server/state-retirement/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getStateRetirementReceipt(db, actor, event.params.id));
});
