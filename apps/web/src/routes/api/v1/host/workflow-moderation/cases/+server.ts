import { json } from '@sveltejs/kit';
import { api, ApiFail } from '$lib/server/api/core';
import { getDb } from '$lib/server/db';
import { requireHostModerator } from '$lib/server/publications/moderation-auth';
import { listModerationCases } from '$lib/server/publications/moderation';
import {
	PUBLICATION_RESPONSE_HEADERS,
	withPublicationHeaders
} from '$lib/server/publications/public';
import type { RequestHandler } from './$types';

const get = api(async (event) => {
	if (!event.platform) throw new ApiFail(500, 'no_platform', 'Platform bindings unavailable');
	const actor = await requireHostModerator(event);
	const rawFilter = event.url.searchParams.get('filter') ?? 'unread';
	if (!['unread', 'open', 'resolved', 'all'].includes(rawFilter))
		throw new ApiFail(422, 'invalid_field', 'Invalid case filter');
	const rawLimit = event.url.searchParams.get('limit');
	const limit = rawLimit === null ? undefined : Number(rawLimit);
	const cursor = event.url.searchParams.get('cursor') ?? undefined;
	const result = await listModerationCases(getDb(event.platform.env), event.platform.env, actor, {
		filter: rawFilter as 'unread' | 'open' | 'resolved' | 'all',
		limit,
		cursor
	});
	return json(result, { headers: PUBLICATION_RESPONSE_HEADERS });
});

export const GET: RequestHandler = (event) => withPublicationHeaders(get(event));
