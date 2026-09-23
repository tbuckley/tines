import { json } from '@sveltejs/kit';
import type { ArtifactListResponse } from '@tines/shared';
import { listArtifacts } from '$lib/server/api/artifacts';
import { readSharedIssue } from '$lib/server/api/shared-issues';
import { resolveIssueAccess } from '$lib/server/api/project-access';
import { api, apiContext } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const access = await resolveIssueAccess(db, actor, event.params.id);
	if (access.role === 'member')
		return json({ items: (await readSharedIssue(db, actor, { id: event.params.id })).artifacts });
	const body: ArtifactListResponse = {
		items: await listArtifacts(db, actor.userId, event.params.id)
	};
	return json(body);
});
