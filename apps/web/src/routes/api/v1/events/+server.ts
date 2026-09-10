import { json } from '@sveltejs/kit';
import type { ListResponse, TinesEvent } from '@tines/shared';
import { api, apiContext, encodeCursor, readPage } from '$lib/server/api/core';
import { eventQuery, serializeEvent } from '$lib/server/api/events';
import type { RequestHandler } from './$types';

/** Global activity feed, newest first. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const page = readPage(event);
	const params = event.url.searchParams;

	let q = eventQuery(db, actor.userId);
	const issue = params.get('issue');
	if (issue) q = q.where('event.issue_id', '=', issue);
	const project = params.get('project');
	if (project) {
		q = q.where((eb) =>
			eb.or([eb('event.project_id', '=', project), eb('event_project.name', '=', project)])
		);
	}
	const type = params.get('type');
	if (type) q = q.where('event.type', '=', type);
	if (page.cursor) {
		const { createdAt, id } = page.cursor;
		q = q.where((eb) =>
			eb.or([
				eb('event.created_at', '<', createdAt),
				eb.and([eb('event.created_at', '=', createdAt), eb('event.id', '<', id)])
			])
		);
	}

	const rows = await q
		.orderBy('event.created_at desc')
		.orderBy('event.id desc')
		.limit(page.limit + 1)
		.execute();
	const items = rows.slice(0, page.limit).map(serializeEvent);
	const last = items[items.length - 1];
	const body: ListResponse<TinesEvent> = {
		items,
		next_cursor: rows.length > page.limit && last ? encodeCursor(last.created_at, last.id) : null
	};
	return json(body);
});
