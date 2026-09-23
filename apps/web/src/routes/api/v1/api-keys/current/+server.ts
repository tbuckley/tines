import { json } from '@sveltejs/kit';
import { currentApiKeyAuthority } from '$lib/server/api/apikeys';
import { api, apiContext } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { actor } = await apiContext(event);
	return json(currentApiKeyAuthority(actor));
});
