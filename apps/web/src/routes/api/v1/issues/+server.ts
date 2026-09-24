import { json } from '@sveltejs/kit';
import type { IssueListItem, ListResponse } from '@tines/shared';
import {
	ApiFail,
	api,
	apiContext,
	encodeCursor,
	readArchived,
	readPage
} from '$lib/server/api/core';
import { listIssuesForActor } from '$lib/server/api/issues';
import { listSharedIssues } from '$lib/server/api/shared-issues';
import { resolveAccessibleProjectRef, resolveProjectAccess } from '$lib/server/api/project-access';
import type { RequestHandler } from './$types';

/** Global issue list across projects. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const page = readPage(event);
	const params = event.url.searchParams;
	const namedProject = params.get('project');
	let projectId: string | null = null;
	if (namedProject) {
		try {
			projectId = await resolveAccessibleProjectRef(db, actor, namedProject);
		} catch (error) {
			if (!(error instanceof ApiFail) || error.status !== 404) throw error;
		}
	}
	const projectAccess = projectId ? await resolveProjectAccess(db, actor, projectId) : null;
	const filters = {
		projectId: projectId ?? undefined,
		project: namedProject && !projectId ? namedProject : undefined,
		state: params.get('state') ?? undefined,
		category: params.get('category') ?? undefined,
		workflow: params.get('workflow') ?? undefined,
		schedule: params.get('schedule') ?? undefined,
		hideDone: ['1', 'true'].includes(params.get('hide_done') ?? ''),
		hideDuplicates: !['false', '0'].includes(params.get('hide_duplicates') ?? ''),
		ready: ['1', 'true'].includes(params.get('ready') ?? ''),
		q: params.get('q') ?? undefined,
		labels: params.getAll('label'),
		brief: ['1', 'true'].includes(params.get('brief') ?? ''),
		archived: readArchived(params)
	};
	const owner = await listIssuesForActor(db, actor, filters, page);
	const member =
		(namedProject && !projectId) || projectAccess?.role === 'owner' || actor.agentRunId
			? { items: [], hasMore: false }
			: await listSharedIssues(db, actor, projectId, {
					limit: page.limit,
					cursor: page.cursor
						? { created_at: page.cursor.createdAt, id: page.cursor.id }
						: undefined,
					...filters
				});
	const merged = [...owner.items, ...member.items].sort(
		(a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id)
	);
	const items = merged.slice(0, page.limit);
	const hasMore = merged.length > page.limit || owner.hasMore || member.hasMore;
	const last = items[items.length - 1];
	const body: ListResponse<IssueListItem | (typeof member.items)[number]> = {
		items,
		next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null
	};
	return json(body);
});
