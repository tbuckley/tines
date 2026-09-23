import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { restorePublication } from '$lib/server/publications/publish';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/api/permissions';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	requireAccess(actor, [{ domain: 'control_plane', access: 'write' }], 'publication.restore');
	return json(await restorePublication(db, env, actor, event.params.candidateId));
});
