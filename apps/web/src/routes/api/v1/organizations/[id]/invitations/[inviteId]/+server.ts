import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { cancelOrganizationInvitation } from '$lib/server/api/organizations';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(
		await cancelOrganizationInvitation(db, actor, event.params.id, event.params.inviteId)
	);
});
