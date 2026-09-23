import { json } from '@sveltejs/kit';
import type { ListResponse, TinesEvent } from '@tines/shared';
import { api, apiContext, encodeCursor, readPage } from '$lib/server/api/core';
import {
	applyEventWindow,
	eventQuery,
	serializeEvent,
	eventTimeParam
} from '$lib/server/api/events';
import type { RequestHandler } from './$types';
import { projectExpressionReadPredicate, requireAccess } from '$lib/server/api/permissions';
import { sql } from 'kysely';

/** Global activity feed, newest first. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const page = readPage(event);
	const params = event.url.searchParams;
	const issue = params.get('issue');
	const project = params.get('project');
	if (issue || project) {
		const row = issue
			? await db
					.selectFrom('issue')
					.innerJoin('project', 'project.id', 'issue.project_id')
					.select(['issue.id', 'issue.project_id'])
					.where('issue.id', '=', issue)
					.where('project.user_id', '=', actor.userId)
					.executeTakeFirst()
			: await db
					.selectFrom('project')
					.select(['project.id as project_id'])
					.where('project.user_id', '=', actor.userId)
					.where((eb) =>
						eb.or([eb('project.id', '=', project!), eb('project.name', '=', project!)])
					)
					.executeTakeFirst();
		if (!row) return json({ items: [], next_cursor: null });
		requireAccess(
			actor,
			[{ domain: 'project', access: 'read', projectId: row.project_id }],
			'event.read',
			{ projectId: row.project_id, issueId: issue ?? undefined }
		);
	} else {
		requireAccess(actor, [{ domain: 'control_plane', access: 'read' }], 'event.read');
	}

	let q = applyEventWindow(eventQuery(db, actor.userId), {
		since: eventTimeParam(params, 'since'),
		until: eventTimeParam(params, 'until'),
		type: params.get('type')?.split(',').filter(Boolean),
		state: params.get('state') ?? undefined
	}).where(
		projectExpressionReadPredicate(
			actor,
			sql<string | null>`coalesce(event.project_id, issue.project_id)`
		)
	);
	if (issue) q = q.where('event.issue_id', '=', issue);
	if (project) {
		q = q.where((eb) =>
			eb.or([eb('event.project_id', '=', project), eb('event_project.name', '=', project)])
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
