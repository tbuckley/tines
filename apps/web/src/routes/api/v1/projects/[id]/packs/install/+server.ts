import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { installFromSource, installPack } from '$lib/server/api/packs/install';
import type { RequestHandler } from './$types';

/** Installs the reviewed pack: refused unless the upload has `expected_digest`. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ source_pack_id?: string }>(event);
	const receipt =
		typeof body.source_pack_id === 'string'
			? await installFromSource(db, env, actor, event.params.id, body.source_pack_id, body)
			: await installPack(db, env, actor, event.params.id, body);
	return json(receipt, { status: 201 });
});
