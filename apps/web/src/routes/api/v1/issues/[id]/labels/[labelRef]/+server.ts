import { api, apiContext } from '$lib/server/api/core';
import { removeIssueLabel } from '$lib/server/api/labels';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	await removeIssueLabel(db, env, actor, effects, event.params.id, event.params.labelRef);
	return new Response(null, { status: 204 });
});
