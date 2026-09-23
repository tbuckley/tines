import { json } from '@sveltejs/kit';
import type { UpdateApiKeyRequest } from '@tines/shared';
import { getApiKey, revokeApiKey, updateApiKeyPermissions } from '$lib/server/api/apikeys';
import { api, apiContext, readJson } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getApiKey(db, actor, event.params.id));
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdateApiKeyRequest>(event);
	return json(
		await updateApiKeyPermissions(
			db,
			env,
			actor,
			event.params.id,
			body.permissions,
			body.expected_permissions
		)
	);
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	await revokeApiKey(db, env, actor, event.params.id);
	return new Response(null, { status: 204 });
});
