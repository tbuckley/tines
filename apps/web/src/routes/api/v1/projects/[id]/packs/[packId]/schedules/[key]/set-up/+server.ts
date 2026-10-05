import { json } from '@sveltejs/kit';
import { api, apiContext, readOptionalJson } from '$lib/server/api/core';
import { setUpPackSchedule } from '$lib/server/api/packs/authoring';
import type { RequestHandler } from './$types';

/** Creates an ordinary, enabled project schedule from the suggestion. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readOptionalJson<{ timezone?: string }>(event);
	return json(
		await setUpPackSchedule(
			db,
			env,
			actor,
			event.params.id,
			event.params.packId,
			event.params.key,
			body
		),
		{ status: 201 }
	);
});
