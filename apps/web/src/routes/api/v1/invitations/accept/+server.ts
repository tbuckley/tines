import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { acceptInvitation } from '$lib/server/api/invitations';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event, { sessionOnly: true });
	const body = await readJson<{ token?: string }>(event);
	return json(await acceptInvitation(db, env, actor, body.token ?? ''));
});
