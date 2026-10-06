import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { prepareInstall, prepareInstallFromSource } from '$lib/server/api/packs/install';
import type { RequestHandler } from './$types';

/** Reviews a pack (an upload, or `source_pack_id`) for install. Writes nothing. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ source_pack_id?: string }>(event);
	return json(
		typeof body.source_pack_id === 'string'
			? await prepareInstallFromSource(db, env, actor, event.params.id, body.source_pack_id)
			: await prepareInstall(db, actor, event.params.id, body)
	);
});
