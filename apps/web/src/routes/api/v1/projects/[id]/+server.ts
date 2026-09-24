import { json } from '@sveltejs/kit';
import type { DeleteAnchorRequest, UpdateProjectRequest } from '@tines/shared';
import { api, apiContext, readJson, readOptionalJson } from '$lib/server/api/core';
import { deleteProject, getProject, updateProject } from '$lib/server/api/projects';
import { actorForProject, resolveProjectAccess } from '$lib/server/api/project-access';
import { readSharedProject } from '$lib/server/api/shared-projects';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const access = await resolveProjectAccess(db, actor, event.params.id);
	return json(
		access.role === 'owner'
			? await getProject(db, actor, event.params.id)
			: await readSharedProject(db, actor, event.params.id)
	);
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	// Members work on shared projects with the owner's scope (project-access.ts).
	const actor = await actorForProject(db, requester, event.params.id);
	const body = await readJson<UpdateProjectRequest>(event);
	return json(await updateProject(db, env, actor, event.params.id, body));
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readOptionalJson<DeleteAnchorRequest>(event);
	const deleted = await deleteProject(db, env, actor, event.params.id, {
		forceDeleteContext: body.force_delete_context === true
	});
	if (deleted.length > 0) return json({ deleted_context: deleted });
	return new Response(null, { status: 204 });
});
