import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { personOf, removeOrganizationMember } from '$lib/server/api/organizations';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	return json(await removeOrganizationMember(db, env, actor, event.params.id, personOf(actor)));
});
