import { json } from '@sveltejs/kit';
import { parseStrictLibraryJson } from '@tines/shared';
import { api, apiContext, ApiFail, requireJsonObject } from '$lib/server/api/core';
import { readLibraryEnvelope } from '$lib/server/library/transport';
import { prepareStateRetirement } from '$lib/server/state-retirement/service';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	let body: Record<string, unknown>;
	try {
		body = requireJsonObject(
			parseStrictLibraryJson(await readLibraryEnvelope(event.request, 32 * 1024 * 1024))
		);
	} catch (error) {
		if (error instanceof ApiFail) throw error;
		throw new ApiFail(400, 'invalid_json', 'Request must be strict JSON');
	}
	return json(await prepareStateRetirement(db, env, actor, body));
});
