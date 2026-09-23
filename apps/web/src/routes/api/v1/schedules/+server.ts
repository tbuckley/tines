import { json } from '@sveltejs/kit';
import type { ListResponse, Schedule } from '@tines/shared';
import {
	ApiFail,
	api,
	apiContext,
	encodeCursor,
	readArchived,
	readPage
} from '$lib/server/api/core';
import { listSchedulesForActor } from '$lib/server/api/schedules';
import { readSharedScheduleSummary } from '$lib/server/api/schedule-consent';
import { resolveAccessibleProjectRef, resolveProjectAccess } from '$lib/server/api/project-access';
import { projectReadPredicate } from '$lib/server/api/permissions';
import type { RequestHandler } from './$types';

/** Global schedule list across projects. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const page = readPage(event);
	const params = event.url.searchParams;
	const enabledRaw = params.get('enabled');
	const namedProject = params.get('project');
	let projectId: string | null = null;
	if (namedProject) {
		try {
			projectId = await resolveAccessibleProjectRef(db, actor, namedProject);
		} catch (error) {
			if (!(error instanceof ApiFail) || error.status !== 404) throw error;
		}
	}
	const access = projectId ? await resolveProjectAccess(db, actor, projectId) : null;
	const archived = readArchived(params);
	const owner = await listSchedulesForActor(
		db,
		actor,
		{
			projectId: projectId ?? undefined,
			project: namedProject && !projectId ? namedProject : undefined,
			enabled: enabledRaw === null ? undefined : ['1', 'true'].includes(enabledRaw),
			archived
		},
		page
	);
	let memberRows: { id: string; created_at: number; project_id: string; revision: number }[] = [];
	if ((!namedProject || projectId) && access?.role !== 'owner' && !actor.agentRunId) {
		let q = db
			.selectFrom('scheduled_task as s')
			.innerJoin('project as p', 'p.id', 's.project_id')
			.innerJoin('project_member as m', (join) =>
				join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', actor.userId)
			)
			.select(['s.id', 's.created_at', 's.project_id', 'm.revision'])
			.where('m.revoked_at', 'is', null)
			.where('p.shared_at', 'is not', null)
			.where(projectReadPredicate(actor, 'p.id'))
			.orderBy('s.created_at desc')
			.orderBy('s.id desc')
			.limit(page.limit + 1);
		if (projectId) q = q.where('s.project_id', '=', projectId);
		else if (archived === 'false') q = q.where('p.archived_at', 'is', null);
		else if (archived === 'true') q = q.where('p.archived_at', 'is not', null);
		if (enabledRaw !== null)
			q = q.where('s.enabled', '=', ['1', 'true'].includes(enabledRaw) ? 1 : 0);
		if (page.cursor)
			q = q.where((eb) =>
				eb.or([
					eb('s.created_at', '<', page.cursor!.createdAt),
					eb.and([
						eb('s.created_at', '=', page.cursor!.createdAt),
						eb('s.id', '<', page.cursor!.id)
					])
				])
			);
		memberRows = await q.execute();
	}
	const member = await Promise.all(
		memberRows.map(async (row) => ({
			created_at: row.created_at,
			id: row.id,
			value: await readSharedScheduleSummary(db, actor, row.id, async () => true)
		}))
	);
	const revisions = await db
		.selectFrom('project_member')
		.select(['project_id', 'revision'])
		.where('user_id', '=', actor.userId)
		.where('revoked_at', 'is', null)
		.execute();
	const current = new Map(revisions.map((row) => [row.project_id, row.revision]));
	if (memberRows.some((row) => current.get(row.project_id) !== row.revision))
		return new Response(null, { status: 404 });
	const merged = [
		...owner.items.map((value) => ({ id: value.id, created_at: value.created_at, value })),
		...member
	].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
	const items = merged.slice(0, page.limit).map((row) => row.value);
	const hasMore = merged.length > page.limit || owner.hasMore || memberRows.length > page.limit;
	const last = merged[Math.min(merged.length, page.limit) - 1];
	const body: ListResponse<Schedule | (typeof member)[number]['value']> = {
		items,
		next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null
	};
	return json(body);
});
