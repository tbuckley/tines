import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { removeOrganizationMember } from '$lib/server/api/organizations';
import type { RequestHandler } from './$types';

/** Removes a person (or, for yourself, leaves). */
export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	return json(await removeOrganizationMember(db, env, actor, event.params.id, event.params.userId));
});
