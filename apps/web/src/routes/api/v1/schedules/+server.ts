import { json } from '@sveltejs/kit';
import type { ListResponse, Schedule } from '@tines/shared';
import { api, apiContext, encodeCursor, readArchived, readPage } from '$lib/server/api/core';
import { listSchedules } from '$lib/server/api/schedules';
import type { RequestHandler } from './$types';

/** Global schedule list across projects. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const page = readPage(event);
	const params = event.url.searchParams;
	const enabledRaw = params.get('enabled');
	const { items, hasMore } = await listSchedules(
		db,
		actor.userId,
		{
			project: params.get('project') ?? undefined,
			enabled: enabledRaw === null ? undefined : ['1', 'true'].includes(enabledRaw),
			archived: readArchived(params)
		},
		page
	);
	const last = items[items.length - 1];
	const body: ListResponse<Schedule> = {
		items,
		next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null
	};
	return json(body);
});
