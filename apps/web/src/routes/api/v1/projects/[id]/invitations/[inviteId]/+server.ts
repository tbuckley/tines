import { api, apiContext, readJson } from '$lib/server/api/core';
import { cancelInvitation } from '$lib/server/api/invitations';
import type { RequestHandler } from './$types';
export const DELETE: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const body = await readJson<{ expected_generation?: unknown }>(event);
	await cancelInvitation(
		db,
		actor,
		event.params.id,
		event.params.inviteId,
		body.expected_generation
	);
	return new Response(null, { status: 204 });
});
