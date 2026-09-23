import { json } from '@sveltejs/kit';
import { api, apiContext, notFound } from '$lib/server/api/core';
import { getIssueDetail } from '$lib/server/api/issues';
import { readSharedIssue } from '$lib/server/api/shared-issues';
import { resolveProjectAccess } from '$lib/server/api/project-access';
import type { RequestHandler } from './$types';

/** Lookup by human-facing ref: project id + per-project issue number. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const number = Number.parseInt(event.params.number, 10);
	if (!Number.isFinite(number)) throw notFound();
	const access = await resolveProjectAccess(db, actor, event.params.id);
	return json(
		access.role === 'owner'
			? await getIssueDetail(
					db,
					actor.userId,
					{ projectId: event.params.id, number },
					{ round: true }
				)
			: await readSharedIssue(db, actor, { projectId: event.params.id, number })
	);
});
