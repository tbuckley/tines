import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { removeMember } from '$lib/server/api/invitations';
import type { RequestHandler } from './$types';
export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ expected_revision?: unknown }>(event);
	return json(
		await removeMember(db, env, actor, event.params.id, event.params.userId, body.expected_revision)
	);
});
