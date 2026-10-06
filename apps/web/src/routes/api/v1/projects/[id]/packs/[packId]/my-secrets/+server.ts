import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { setMySecrets } from '$lib/server/api/packs/authoring';
import type { RequestHandler } from './$types';

/** The caller's own values for the pack's secret inputs. */
export const PUT: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ secrets?: Record<string, string | null> }>(event);
	return json(await setMySecrets(db, env, actor, event.params.id, event.params.packId, body));
});
