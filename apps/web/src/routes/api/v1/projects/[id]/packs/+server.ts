import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { listProjectPacks } from '$lib/server/api/packs/views';
import { packProject } from '$lib/server/api/packs/access';
import { createPack } from '$lib/server/api/packs/authoring';
import type { CreatePackRequest } from '@tines/shared';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const pp = await packProject(db, actor, event.params.id, 'read', 'pack.read');
	return json({
		items: await listProjectPacks(db, event.params.id, pp.personId),
		next_cursor: null
	});
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<CreatePackRequest>(event);
	return json(await createPack(db, env, actor, event.params.id, body), { status: 201 });
});
