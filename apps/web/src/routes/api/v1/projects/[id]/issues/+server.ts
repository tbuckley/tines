import { json } from '@sveltejs/kit';
import type { CreateIssueRequest, Issue, ListResponse } from '@tines/shared';
import { api, apiContext, encodeCursor, readJson, readPage } from '$lib/server/api/core';
import { createIssue, listIssues } from '$lib/server/api/issues';
import { getProject } from '$lib/server/api/projects';
import { queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	// 404 for a project the user doesn't own, before filtering by it.
	await getProject(db, actor.userId, event.params.id);
	const page = readPage(event);
	const params = event.url.searchParams;
	const { items, hasMore } = await listIssues(
		db,
		actor.userId,
		{
			projectId: event.params.id,
			state: params.get('state') ?? undefined,
			category: params.get('category') ?? undefined,
			schedule: params.get('schedule') ?? undefined,
			hideDone: ['1', 'true'].includes(params.get('hide_done') ?? ''),
			ready: ['1', 'true'].includes(params.get('ready') ?? ''),
			q: params.get('q') ?? undefined
		},
		page
	);
	const last = items[items.length - 1];
	const body: ListResponse<Issue> = {
		items,
		next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null
	};
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<CreateIssueRequest>(event);
	const issue = await createIssue(db, env, actor, event.params.id, body);
	// An issue born into an active state may dispatch immediately.
	queueDispatchPass(event.platform, actor.userId);
	return json(issue, { status: 201 });
});
