import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { inviteToOrganization } from '$lib/server/api/organizations';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ email?: unknown }>(event);
	return json(await inviteToOrganization(db, env, actor, event.params.id, body, event.url.origin), {
		status: 201
	});
});
