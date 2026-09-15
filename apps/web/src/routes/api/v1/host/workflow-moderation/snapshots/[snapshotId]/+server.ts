import { json } from '@sveltejs/kit';
import { api, ApiFail } from '$lib/server/api/core';
import { getDb } from '$lib/server/db';
import { inspectModerationSnapshot } from '$lib/server/publications/moderation';
import { requireHostModerator } from '$lib/server/publications/moderation-auth';
import {
	PUBLICATION_RESPONSE_HEADERS,
	withPublicationHeaders
} from '$lib/server/publications/public';
import type { RequestHandler } from './$types';

const get = api(async (event) => {
	if (!event.platform) throw new ApiFail(500, 'no_platform', 'Platform bindings unavailable');
	if (!event.params.snapshotId) throw new ApiFail(404, 'not_found', 'Not found');
	const actor = await requireHostModerator(event);
	return json(
		await inspectModerationSnapshot(
			getDb(event.platform.env),
			event.platform.env,
			actor,
			event.params.snapshotId,
			{
				reportsOffset: Number(event.url.searchParams.get('reports_offset') ?? 0),
				auditOffset: Number(event.url.searchParams.get('audit_offset') ?? 0),
				limit: event.url.searchParams.has('limit')
					? Number(event.url.searchParams.get('limit'))
					: undefined
			}
		),
		{ headers: PUBLICATION_RESPONSE_HEADERS }
	);
});

export const GET: RequestHandler = (event) => withPublicationHeaders(get(event));
