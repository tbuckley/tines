import { json } from '@sveltejs/kit';
import type { CreateProjectRequest, ListResponse, Project } from '@tines/shared';
import { api, apiContext, readArchived, readJson } from '$lib/server/api/core';
import { createProject, listProjects } from '$lib/server/api/projects';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const items = await listProjects(db, actor, {
		archived: readArchived(event.url.searchParams)
	});
	const body: ListResponse<Project> = { items, next_cursor: null };
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<CreateProjectRequest>(event);
	const project = await createProject(db, env, actor, body);
	return json(project, { status: 201 });
});
