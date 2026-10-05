import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { transferOrganization } from '$lib/server/api/organizations';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ to_user_id?: unknown; expected_revision?: unknown }>(event);
	return json(await transferOrganization(db, env, actor, event.params.id, body));
});
