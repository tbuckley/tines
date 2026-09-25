import { json } from '@sveltejs/kit';
import { ApiFail, api, apiContext, readJson } from '$lib/server/api/core';
import { setStateRunScope } from '$lib/server/api/workflows';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = api(async (event) => {
	// Same-origin only, like personal permission: widening agent authority
	// is a browser decision, never a cross-site or scripted one.
	const origin = event.request.headers.get('origin');
	if (!origin || origin !== event.url.origin) {
		throw new ApiFail(403, 'origin_required', 'Run scope changes require this browser origin');
	}
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ run_scope?: unknown }>(event);
	return json(await setStateRunScope(db, env, actor, event.params.id, event.params.stateId, body));
});
