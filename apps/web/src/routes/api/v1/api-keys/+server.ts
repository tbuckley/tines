import { json } from '@sveltejs/kit';
import type { ApiKey, CreateApiKeyRequest, ListResponse, RunKeyFilter } from '@tines/shared';
import { RUN_KEY_FILTERS } from '@tines/shared';
import { createApiKey, listApiKeys } from '$lib/server/api/apikeys';
import { api, ApiFail, apiContext, readJson } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

// Keys are managed from a browser session only — a key cannot mint or list
// keys (sessionOnly enforces that).

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event, { sessionOnly: true });
	// Run keys are one per agent run and never deleted, so the default view
	// carries only the ones that can still act; ?run_keys= widens or drops it.
	const raw = event.url.searchParams.get('run_keys');
	if (raw !== null && !(RUN_KEY_FILTERS as readonly string[]).includes(raw)) {
		throw new ApiFail(
			422,
			'invalid_field',
			`"run_keys" must be one of ${RUN_KEY_FILTERS.join(', ')}`,
			{ field: 'run_keys' }
		);
	}
	const body: ListResponse<ApiKey> = {
		items: await listApiKeys(db, actor.userId, { runKeys: (raw as RunKeyFilter) ?? undefined }),
		next_cursor: null
	};
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event, { sessionOnly: true });
	const body = await readJson<CreateApiKeyRequest>(event);
	const key = await createApiKey(db, env, actor, body.name, body.permissions);
	return json(key, { status: 201 });
});
