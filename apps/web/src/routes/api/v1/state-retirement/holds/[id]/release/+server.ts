import { json } from '@sveltejs/kit';
import { parseStrictLibraryJson } from '@tines/shared';
import { api, apiContext, ApiFail, requireJsonObject } from '$lib/server/api/core';
import { readLibraryEnvelope } from '$lib/server/library/transport';
import { releaseStateRetirementHold } from '$lib/server/state-retirement/service';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	try {
		const body = requireJsonObject(
			parseStrictLibraryJson(await readLibraryEnvelope(event.request, 64 * 1024))
		);
		return json(await releaseStateRetirementHold(db, env, actor, event.params.id, body as never));
	} catch (error) {
		if (error instanceof ApiFail) throw error;
		throw new ApiFail(400, 'invalid_json', 'Request must be strict JSON');
	}
});
