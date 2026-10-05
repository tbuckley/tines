import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { moveIssuesPreview, movePackIssues } from '$lib/server/api/packs/authoring';
import { ApiFail } from '$lib/server/api/core';
import type { MovePackIssuesRequest } from '@tines/shared';
import type { RequestHandler } from './$types';

/** `?from=<workflow id>`: what moving that workflow's issues here involves. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const from = event.url.searchParams.get('from');
	if (!from) throw new ApiFail(422, 'invalid_field', 'Pass ?from=<workflow id>', { field: 'from' });
	return json(
		await moveIssuesPreview(
			db,
			actor,
			event.params.id,
			event.params.packId,
			from,
			event.params.workflowId
		)
	);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<MovePackIssuesRequest>(event);
	return json(
		await movePackIssues(
			db,
			env,
			actor,
			event.params.id,
			event.params.packId,
			event.params.workflowId,
			body
		)
	);
});
