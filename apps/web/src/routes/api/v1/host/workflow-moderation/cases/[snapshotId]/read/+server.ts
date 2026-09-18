import { json } from '@sveltejs/kit';
import { api, ApiFail, readJson } from '$lib/server/api/core';
import { getDb } from '$lib/server/db';
import { markModerationCaseRead } from '$lib/server/publications/moderation';
import { requireHostModerator } from '$lib/server/publications/moderation-auth';
import {
	PUBLICATION_RESPONSE_HEADERS,
	withPublicationHeaders
} from '$lib/server/publications/public';
import type { RequestHandler } from './$types';

const post = api(async (event) => {
	if (!event.platform) throw new ApiFail(500, 'no_platform', 'Platform bindings unavailable');
	if (!event.params.snapshotId) throw new ApiFail(404, 'not_found', 'Not found');
	if (event.request.headers.get('origin') !== event.url.origin)
		throw new ApiFail(403, 'invalid_origin', 'Same-origin browser request required');
	if (event.request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
		throw new ApiFail(415, 'unsupported_media_type', 'Use application/json');
	const actor = await requireHostModerator(event);
	const body = await readJson<{ through_version: number }>(event);
	return json(
		await markModerationCaseRead(
			getDb(event.platform.env),
			event.platform.env,
			actor,
			event.params.snapshotId,
			body.through_version
		),
		{ headers: PUBLICATION_RESPONSE_HEADERS }
	);
});

export const POST: RequestHandler = (event) => withPublicationHeaders(post(event));
