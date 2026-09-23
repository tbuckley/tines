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
		const page = readPage(event);
		const rows = await db
			.selectFrom('scheduled_task')
			.select(['id', 'created_at'])
			.where('project_id', '=', event.params.id)
			.$if(page.cursor !== null, (q) =>
				q.where((eb) =>
					eb.or([
						eb('created_at', '<', page.cursor!.createdAt),
						eb.and([eb('created_at', '=', page.cursor!.createdAt), eb('id', '<', page.cursor!.id)])
					])
				)
			)
			.orderBy('created_at desc')
			.orderBy('id desc')
			.limit(page.limit + 1)
			.execute();
		const items = await Promise.all(
			rows
				.slice(0, page.limit)
				.map((row) => readSharedScheduleSummary(db, actor, row.id, async () => true))
		);
		if (
			(await resolveProjectAccess(db, actor, event.params.id)).membershipRevision !==
			access.membershipRevision
		)
			throw notFound();
		const last = rows[Math.min(rows.length, page.limit) - 1];
		return json({
			items,
			next_cursor: rows.length > page.limit && last ? encodeCursor(last.created_at, last.id) : null
		});
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
