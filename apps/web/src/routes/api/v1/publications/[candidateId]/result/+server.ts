import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { getPublicationResult } from '$lib/server/publications/publish';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/api/permissions';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	requireAccess(actor, [{ domain: 'control_plane', access: 'read' }], 'publication.read');
	return json(await getPublicationResult(db, actor, event.params.candidateId));
});
