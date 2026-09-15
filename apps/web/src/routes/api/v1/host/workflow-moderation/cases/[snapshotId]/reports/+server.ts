import { json } from '@sveltejs/kit';
import { api, ApiFail } from '$lib/server/api/core';
import { getDb } from '$lib/server/db';
import type { PublicationReportReason } from '@tines/shared';
import {
	listModerationReportReceipts,
	listModerationReports
} from '$lib/server/publications/moderation';
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
	const rawLimit = event.url.searchParams.get('limit');
	const reason = event.url.searchParams.get('reason');
	const noteHash = event.url.searchParams.get('note_hash');
	if ((reason === null) !== (noteHash === null))
		throw new ApiFail(422, 'invalid_field', 'reason and note_hash must be provided together');
	return json(
		reason && noteHash
			? await listModerationReportReceipts(
					getDb(event.platform.env),
					event.platform.env,
					actor,
					event.params.snapshotId,
					{ reason: reason as PublicationReportReason, noteHash },
					{
						limit: rawLimit === null ? undefined : Number(rawLimit),
						cursor: event.url.searchParams.get('cursor') ?? undefined
					}
				)
			: await listModerationReports(
					getDb(event.platform.env),
					event.platform.env,
					actor,
					event.params.snapshotId,
					{
						limit: rawLimit === null ? undefined : Number(rawLimit),
						cursor: event.url.searchParams.get('cursor') ?? undefined
					}
				),
		{ headers: PUBLICATION_RESPONSE_HEADERS }
	);
});

export const GET: RequestHandler = (event) => withPublicationHeaders(get(event));
