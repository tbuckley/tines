import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { api, apiContext } from '$lib/server/api/core';
import { retireRate } from '$lib/server/api/rates';

export const DELETE: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	await retireRate(db, actor.userId, event.params.id);
	return json({ ok: true });
});
