import { json } from '@sveltejs/kit';
import type { UpsertArtifactRequest } from '@tines/shared';
import { deleteArtifact, getArtifactDetail, upsertArtifact } from '$lib/server/api/artifacts';
import { readSharedArtifact } from '$lib/server/api/shared-issues';
import { resolveIssueAccess } from '$lib/server/api/project-access';
import { api, apiContext, readJson } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const access = await resolveIssueAccess(db, actor, event.params.id);
	return json(
		access.role === 'owner'
			? await getArtifactDetail(db, actor.userId, event.params.id, event.params.name)
			: await readSharedArtifact(db, actor, event.params.id, event.params.name)
	);
});

/** JSON upsert for text/link/pr: creates the artifact or appends a version. */
export const PUT: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpsertArtifactRequest>(event);
	return json(await upsertArtifact(db, env, actor, event.params.id, event.params.name, body));
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	await deleteArtifact(db, env, actor, event.params.id, event.params.name);
	return new Response(null, { status: 204 });
});
