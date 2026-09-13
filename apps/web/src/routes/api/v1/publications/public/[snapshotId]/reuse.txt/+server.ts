import { publicationReuseNotice } from '@tines/shared';
import { api, ApiFail } from '$lib/server/api/core';
import { getDb } from '$lib/server/db';
import {
	PUBLICATION_RESPONSE_HEADERS,
	PUBLICATION_UNAVAILABLE_MESSAGE,
	resolvePublicSnapshot,
	withPublicationHeaders
} from '$lib/server/publications/public';
import type { RequestHandler } from './$types';

const get = api(async (event) => {
	if (!event.platform) throw new ApiFail(500, 'no_platform', 'Platform bindings unavailable');
	const snapshot = await resolvePublicSnapshot(getDb(event.platform.env), event.params.snapshotId);
	if (!snapshot) throw new ApiFail(404, 'publication_unavailable', PUBLICATION_UNAVAILABLE_MESSAGE);
	return new Response(publicationReuseNotice(snapshot.metadata), {
		headers: {
			...PUBLICATION_RESPONSE_HEADERS,
			'content-type': 'text/plain; charset=utf-8',
			'content-disposition': 'attachment; filename="reuse.txt"'
		}
	});
});

export const GET: RequestHandler = (event) => withPublicationHeaders(get(event));
