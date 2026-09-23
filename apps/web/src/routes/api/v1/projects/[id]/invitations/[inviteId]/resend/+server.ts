import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { resendInvitation } from '$lib/server/api/invitations';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ expected_generation?: unknown }>(event);
	return json(
		await resendInvitation(
			db,
			env,
			actor,
			event.params.id,
			event.params.inviteId,
			body.expected_generation,
			event.url.origin
		)
	);
});
