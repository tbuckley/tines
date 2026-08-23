import { json } from '@sveltejs/kit';
import type { UpdateProjectRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { deleteProject, getProject, updateProject } from '$lib/server/api/projects';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getProject(db, actor.userId, event.params.id));
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdateProjectRequest>(event);
	return json(await updateProject(db, env, actor, event.params.id, body));
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	await deleteProject(db, env, actor, event.params.id);
	return new Response(null, { status: 204 });
});
