import { json } from '@sveltejs/kit';
import type { ListResponse, TinesEvent } from '@tines/shared';
import { ApiFail, api, apiContext, encodeCursor, readPage } from '$lib/server/api/core';
import {
	applyEventWindow,
	eventQuery,
	serializeEvent,
	eventTimeParam
} from '$lib/server/api/events';
import { listSharedEvents } from '$lib/server/api/shared-events';
import { resolveAccessibleProjectRef, resolveProjectAccess } from '$lib/server/api/project-access';
import { resolveIssueAccess } from '$lib/server/api/project-access';
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
	let projectId: string | null = null;
	if (project) {
		try {
			projectId = await resolveAccessibleProjectRef(db, actor, project);
		} catch (error) {
			if (!(error instanceof ApiFail) || error.status !== 404) throw error;
		}
	}
	const projectAccess = projectId ? await resolveProjectAccess(db, actor, projectId) : null;
	if (issue) {
		try {
			await resolveIssueAccess(db, actor, issue);
		} catch (error) {
			if (error instanceof ApiFail && (error.status === 403 || error.status === 404))
				return json({ items: [], next_cursor: null });
			throw error;
		}
	}
	if (!issue && !project)
		requireAccess(actor, [{ domain: 'control_plane', access: 'read' }], 'event.read');
	const since = eventTimeParam(params, 'since');
	const until = eventTimeParam(params, 'until');
	const types = params.get('type')?.split(',').filter(Boolean);

	let q = applyEventWindow(eventQuery(db, actor.userId), {
		since,
		until,
		type: types,
		state: params.get('state') ?? undefined
	}).where(
		projectExpressionReadPredicate(
			actor,
			sql<string | null>`coalesce(event.project_id, issue.project_id)`
		)
	);
	if (issue) q = q.where('event.issue_id', '=', issue);
	if (projectId) q = q.where('event.project_id', '=', projectId);
	else if (project)
		q = q.where((eb) =>
			eb.or([eb('event.project_id', '=', project), eb('event_project.name', '=', project)])
		);
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
	const member =
		(project && !projectId) || projectAccess?.role === 'owner' || actor.agentRunId
			? { items: [], hasMore: false }
			: await listSharedEvents(db, actor, {
					projectId: projectId ?? undefined,
					issueId: issue ?? undefined,
					type: types,
					since,
					until,
					state: params.get('state') ?? undefined,
					cursor: page.cursor ?? undefined,
					limit: page.limit
				});
	const merged = [...rows.slice(0, page.limit).map(serializeEvent), ...member.items].sort(
		(a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id)
	);
	const items = merged.slice(0, page.limit);
	const last = items.at(-1);
	const body: ListResponse<TinesEvent> = {
		items,
		next_cursor:
			(rows.length > page.limit || member.hasMore || merged.length > page.limit) && last
				? encodeCursor(last.created_at, last.id)
				: null
	};
	return json(body);
});
