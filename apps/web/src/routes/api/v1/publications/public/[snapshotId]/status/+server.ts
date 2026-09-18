import { json } from '@sveltejs/kit';
import { api, ApiFail } from '$lib/server/api/core';
import { getDb } from '$lib/server/db';
import {
	PUBLICATION_RESPONSE_HEADERS,
	PUBLICATION_UNAVAILABLE_MESSAGE,
	resolvePublicSnapshotStatus,
	withPublicationHeaders
} from '$lib/server/publications/public';
import type { RequestHandler } from './$types';

const get = api(async (event) => {
	if (!event.platform) throw new ApiFail(500, 'no_platform', 'Platform bindings unavailable');
	const snapshotId = event.params.snapshotId;
	if (!snapshotId)
		throw new ApiFail(404, 'publication_unavailable', PUBLICATION_UNAVAILABLE_MESSAGE);
	const status = await resolvePublicSnapshotStatus(getDb(event.platform.env), snapshotId);
	if (!status) throw new ApiFail(404, 'publication_unavailable', PUBLICATION_UNAVAILABLE_MESSAGE);
	return json(status, { headers: PUBLICATION_RESPONSE_HEADERS });
});

export const GET: RequestHandler = (event) => withPublicationHeaders(get(event));
