import { json } from '@sveltejs/kit';
import { api, apiContext, requireString } from '$lib/server/api/core';
import { loadSentBackDrilldown } from '$lib/server/api/supervisor';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(
		await loadSentBackDrilldown(db, actor.userId, {
			state: requireString(event.url.searchParams.get('state'), 'state'),
			window: event.url.searchParams.get('window') ?? undefined,
			project: event.url.searchParams.get('project') ?? undefined
		})
	);
});
