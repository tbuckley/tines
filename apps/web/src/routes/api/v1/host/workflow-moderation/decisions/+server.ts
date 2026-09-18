import { json } from '@sveltejs/kit';
import type { ModerationDecisionRequest } from '@tines/shared';
import { api, ApiFail, readJson } from '$lib/server/api/core';
import { getDb } from '$lib/server/db';
import { decideModeration } from '$lib/server/publications/moderation';
import { requireHostModerator } from '$lib/server/publications/moderation-auth';
import {
	PUBLICATION_RESPONSE_HEADERS,
	withPublicationHeaders
} from '$lib/server/publications/public';
import type { RequestHandler } from './$types';

const post = api(async (event) => {
	if (!event.platform) throw new ApiFail(500, 'no_platform', 'Platform bindings unavailable');
	if (event.request.headers.get('origin') !== event.url.origin)
		throw new ApiFail(403, 'invalid_origin', 'Same-origin browser request required');
	if (event.request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
		throw new ApiFail(415, 'unsupported_media_type', 'Use application/json');
	const actor = await requireHostModerator(event);
	const body = await readJson<ModerationDecisionRequest>(event);
	return json(await decideModeration(getDb(event.platform.env), event.platform.env, actor, body), {
		headers: PUBLICATION_RESPONSE_HEADERS
	});
});

export const POST: RequestHandler = (event) => withPublicationHeaders(post(event));
