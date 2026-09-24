import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { listPeople } from '$lib/server/api/invitations';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await listPeople(db, actor, event.params.id));
});
