import { json } from '@sveltejs/kit';
import type { AgentRun, ListResponse } from '@tines/shared';
import { api, apiContext, encodeCursor, readPage } from '$lib/server/api/core';
import { listRuns } from '$lib/server/api/runs';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const page = readPage(event);
	const params = event.url.searchParams;
	const { items, hasMore } = await listRuns(
		db,
		actor.userId,
		{
			issue: params.get('issue') ?? undefined,
			runner: params.get('runner') ?? undefined,
			state: params.get('state') ?? undefined,
			active: ['1', 'true'].includes(params.get('active') ?? '')
		},
		page
	);
	const last = items[items.length - 1];
	const body: ListResponse<AgentRun> = {
		items,
		next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null
	};
	return json(body);
});
