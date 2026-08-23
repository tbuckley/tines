import { json } from '@sveltejs/kit';
import type { ApiKey, CreateApiKeyRequest, ListResponse } from '@tines/shared';
import { createApiKey, listApiKeys } from '$lib/server/api/apikeys';
import { api, apiContext, readJson } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

// Keys are managed from a browser session only — a key cannot mint or list
// keys (sessionOnly enforces that).

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event, { sessionOnly: true });
	const body: ListResponse<ApiKey> = { items: await listApiKeys(db, actor.userId), next_cursor: null };
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event, { sessionOnly: true });
	const body = await readJson<CreateApiKeyRequest>(event);
	const key = await createApiKey(db, env, actor, body.name);
	return json(key, { status: 201 });
});
