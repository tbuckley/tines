import { json } from '@sveltejs/kit';
import type { ListResponse, TinesEvent } from '@tines/shared';
import { api, apiContext, encodeCursor, readPage } from '$lib/server/api/core';
import { ApiFail } from '$lib/server/api/core';
import { applyEventWindow, eventQuery, serializeEvent } from '$lib/server/api/events';
import type { RequestHandler } from './$types';

/** Global activity feed, newest first. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const page = readPage(event);
	const params = event.url.searchParams;

	function timeParam(name: 'since' | 'until'): number | undefined {
		const value = params.get(name);
		if (!value) return undefined;
		const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
		if (!Number.isFinite(parsed)) {
			throw new ApiFail(
				422,
				'validation_error',
				`"${name}" must be epoch milliseconds or ISO 8601`,
				{ field: name }
			);
		}
		return parsed;
	}

	let q = applyEventWindow(eventQuery(db, actor.userId), {
		since: timeParam('since'),
		until: timeParam('until'),
		type: params.get('type')?.split(',').filter(Boolean),
		state: params.get('state') ?? undefined
	});
	const issue = params.get('issue');
	if (issue) q = q.where('event.issue_id', '=', issue);
	const project = params.get('project');
	if (project) {
		q = q.where((eb) =>
			eb.or([eb('event.project_id', '=', project), eb('project.name', '=', project)])
		);
	}
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
