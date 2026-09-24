import { json } from '@sveltejs/kit';
import type { UpsertArtifactRequest } from '@tines/shared';
import {
	deleteArtifact,
	getArtifactDetailForActor,
	upsertArtifact
} from '$lib/server/api/artifacts';
import { actorForIssue } from '$lib/server/api/project-access';
import { api, apiContext, readJson } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor: requester } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	return json(await getArtifactDetailForActor(db, actor, event.params.id, event.params.name));
});

/** JSON upsert for text/link/pr: creates the artifact or appends a version. */
export const PUT: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	const body = await readJson<UpsertArtifactRequest>(event);
	return json(await upsertArtifact(db, env, actor, event.params.id, event.params.name, body));
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	await deleteArtifact(db, env, actor, event.params.id, event.params.name);
	return new Response(null, { status: 204 });
});
