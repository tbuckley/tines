import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { suggestPackSchedule } from '$lib/server/api/packs/authoring';
import type { SuggestPackScheduleRequest } from '@tines/shared';
import type { RequestHandler } from './$types';

/** Suggest in pack: copies a schedule on one of the pack's workflows into the pack. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<SuggestPackScheduleRequest>(event);
	return json(
		await suggestPackSchedule(db, env, actor, event.params.id, event.params.packId, body),
		{
			status: 201
		}
	);
});
