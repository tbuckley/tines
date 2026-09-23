import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { createInvitation, listInvitations } from '$lib/server/api/invitations';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json({ items: await listInvitations(db, actor, event.params.id), next_cursor: null });
});
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{
		email?: unknown;
		landing_issue_id?: unknown;
		confirm_sharing?: unknown;
		expected_sharing_revision?: unknown;
	}>(event);
	return json(await createInvitation(db, env, actor, event.params.id, body, event.url.origin), {
		status: 201
	});
});
