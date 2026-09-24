import { json } from '@sveltejs/kit';
import { ApiFail, api, apiContext, readJson } from '$lib/server/api/core';
import { acknowledgeDisclosure } from '$lib/server/api/personal-consent';
import type { RequestHandler } from './$types';

// "Got it" on the personal-permission notice. Same-origin browser sessions
// only, matching the personal-permission writes the notice sits beside.
export const PUT: RequestHandler = api(async (event) => {
	const origin = event.request.headers.get('origin');
	if (!origin || origin !== event.url.origin) {
		throw new ApiFail(
			403,
			'origin_required',
			'Acknowledging the personal permission notice requires this browser origin'
		);
	}
	const { db, actor } = await apiContext(event);
	const body = await readJson<{ version?: unknown }>(event);
	return json(await acknowledgeDisclosure(db, actor, body));
});
