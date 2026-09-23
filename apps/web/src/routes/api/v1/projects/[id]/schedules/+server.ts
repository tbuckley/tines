import { json } from '@sveltejs/kit';
import type { ListResponse, Schedule } from '@tines/shared';
import { api, apiContext, encodeCursor, readPage } from '$lib/server/api/core';
import { getProject } from '$lib/server/api/projects';
import { listSchedules } from '$lib/server/api/schedules';
import { readSharedScheduleSummary } from '$lib/server/api/schedule-consent';
import { resolveProjectAccess } from '$lib/server/api/project-access';
import { notFound } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	// 404 for a project the user doesn't own, before filtering by it.
	const access = await resolveProjectAccess(db, actor, event.params.id);
	if (access.role === 'member') {
		const rows = await db
			.selectFrom('scheduled_task')
			.select('id')
			.where('project_id', '=', event.params.id)
			.orderBy('created_at desc')
			.limit(100)
			.execute();
		const items = await Promise.all(
			rows.map((row) => readSharedScheduleSummary(db, actor, row.id, async () => true))
		);
		if (
			(await resolveProjectAccess(db, actor, event.params.id)).membershipRevision !==
			access.membershipRevision
		)
			throw notFound();
		return json({ items, next_cursor: null });
	}
	const page = readPage(event);
	const { items, hasMore } = await listSchedules(
		db,
		actor.userId,
		{ projectId: event.params.id },
		page
	);
	const last = items[items.length - 1];
	const body: ListResponse<Schedule> = {
		items,
		next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null
	};
	return json(body);
});
