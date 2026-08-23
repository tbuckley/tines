import { json } from '@sveltejs/kit';
import type { ListResponse, Schedule } from '@tines/shared';
import { api, apiContext, encodeCursor, readPage } from '$lib/server/api/core';
import { getProject } from '$lib/server/api/projects';
import { listSchedules } from '$lib/server/api/schedules';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	// 404 for a project the user doesn't own, before filtering by it.
	await getProject(db, actor.userId, event.params.id);
	const page = readPage(event);
	const { items, hasMore } = await listSchedules(db, actor.userId, { projectId: event.params.id }, page);
	const last = items[items.length - 1];
	const body: ListResponse<Schedule> = {
		items,
		next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null
	};
	return json(body);
});
