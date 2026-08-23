import { revokeApiKey } from '$lib/server/api/apikeys';
import { api, apiContext } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event, { sessionOnly: true });
	await revokeApiKey(db, env, actor, event.params.id);
	return new Response(null, { status: 204 });
});
