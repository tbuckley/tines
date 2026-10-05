import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { ApiFail } from '$lib/server/api/core';
import { moveProject, previewProjectMove } from '$lib/server/api/org-move';
import type { MoveProjectRequest } from '@tines/shared';
import type { RequestHandler } from './$types';

/** `?to=<organization id>`: what moving the project there does. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const to = event.url.searchParams.get('to');
	if (!to) throw new ApiFail(422, 'invalid_field', 'Pass ?to=<organization id>', { field: 'to' });
	return json(await previewProjectMove(db, actor, event.params.id, to));
});

/** Moves the project: refused unless `expected_digest` is the preview's. Browser only. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<Partial<MoveProjectRequest>>(event);
	return json(await moveProject(db, env, actor, event.params.id, body));
});
