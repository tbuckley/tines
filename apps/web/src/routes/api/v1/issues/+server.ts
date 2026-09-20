import { json } from '@sveltejs/kit';
import type { IssueListItem, ListResponse } from '@tines/shared';
import { api, apiContext, encodeCursor, readArchived, readPage } from '$lib/server/api/core';
import { listIssues } from '$lib/server/api/issues';
import type { RequestHandler } from './$types';

/** Global issue list across projects. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const page = readPage(event);
	const params = event.url.searchParams;
	const { items, hasMore } = await listIssues(
		db,
		actor.userId,
		{
			project: params.get('project') ?? undefined,
			state: params.get('state') ?? undefined,
			category: params.get('category') ?? undefined,
			workflow: params.get('workflow') ?? undefined,
			schedule: params.get('schedule') ?? undefined,
			hideDone: ['1', 'true'].includes(params.get('hide_done') ?? ''),
			hideDuplicates: !['false', '0'].includes(params.get('hide_duplicates') ?? ''),
			ready: ['1', 'true'].includes(params.get('ready') ?? ''),
			q: params.get('q') ?? undefined,
			labels: params.getAll('label'),
			// brief=1 omits description bodies, which are most of the payload.
			brief: ['1', 'true'].includes(params.get('brief') ?? ''),
			archived: readArchived(params)
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
