import { json } from '@sveltejs/kit';
import type { CreateIssueRequest, IssueListItem, ListResponse } from '@tines/shared';
import { api, apiContext, encodeCursor, readJson, readPage } from '$lib/server/api/core';
import { createIssue, listIssues } from '$lib/server/api/issues';
import { readIssueCreateMultipart } from '$lib/server/api/issue-create-files';
import { getProject } from '$lib/server/api/projects';
import { assertWritable } from '$lib/server/api/archive';
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
			workflow: params.get('workflow') ?? undefined,
			state: params.get('state') ?? undefined,
			category: params.get('category') ?? undefined,
			schedule: params.get('schedule') ?? undefined,
			hideDone: ['1', 'true'].includes(params.get('hide_done') ?? ''),
			ready: ['1', 'true'].includes(params.get('ready') ?? ''),
			q: params.get('q') ?? undefined,
			labels: params.getAll('label'),
			// brief=1 omits description bodies, which are most of the payload.
			brief: ['1', 'true'].includes(params.get('brief') ?? '')
		},
		page
	);
	const last = items[items.length - 1];
	const body: ListResponse<IssueListItem> = {
		items,
		next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null
	};
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	if (
		(event.request.headers.get('content-type') ?? '')
			.toLowerCase()
			.startsWith('multipart/form-data')
	) {
		// Reject foreign/archived projects before consuming a potentially large body.
		const project = await getProject(db, actor.userId, event.params.id);
		await assertWritable(db, actor, project);
		const parsed = await readIssueCreateMultipart(event.request);
		const issue = await createIssue(
			db,
			env,
			actor,
			effects,
			event.params.id,
			parsed.issue,
			parsed.files
		);
		return json(issue, { status: 201 });
	}
	const body = await readJson<CreateIssueRequest>(event);
	const issue = await createIssue(db, env, actor, effects, event.params.id, body);
	return json(issue, { status: 201 });
});
