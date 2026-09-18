import { json } from '@sveltejs/kit';
import { api, ApiFail } from '$lib/server/api/core';
import { getDb } from '$lib/server/db';
import { listSuspendedPublishers } from '$lib/server/publications/moderation';
import { requireHostModerator } from '$lib/server/publications/moderation-auth';
import {
	PUBLICATION_RESPONSE_HEADERS,
	withPublicationHeaders
} from '$lib/server/publications/public';
import type { RequestHandler } from './$types';

const get = api(async (event) => {
	if (!event.platform) throw new ApiFail(500, 'no_platform', 'Platform bindings unavailable');
	const actor = await requireHostModerator(event);
	const filter = event.url.searchParams.get('filter') ?? 'suspended';
	if (filter !== 'suspended') throw new ApiFail(422, 'invalid_field', 'Invalid publisher filter');
	const rawLimit = event.url.searchParams.get('limit');
	return json(
		await listSuspendedPublishers(getDb(event.platform.env), event.platform.env, actor, {
			limit: rawLimit === null ? undefined : Number(rawLimit),
			cursor: event.url.searchParams.get('cursor') ?? undefined
		}),
		{ headers: PUBLICATION_RESPONSE_HEADERS }
	);
});

export const GET: RequestHandler = (event) => withPublicationHeaders(get(event));
