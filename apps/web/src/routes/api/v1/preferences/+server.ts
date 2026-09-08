import { json } from '@sveltejs/kit';
import type { UpdatePreferencesRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { getPreferences, updatePreferences } from '$lib/server/api/preferences';
import type { RequestHandler } from './$types';

// Cookie and PAT sessions both reach these (the e2e reset helper is a PAT);
// run keys are stopped earlier, by the control-plane fence in core.ts.

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getPreferences(db, actor.userId));
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdatePreferencesRequest>(event);
	return json(await updatePreferences(db, env, actor, body));
});
