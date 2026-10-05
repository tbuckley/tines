import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { createOrganization, listOrganizations } from '$lib/server/api/organizations';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json({ items: await listOrganizations(db, actor), next_cursor: null });
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ name?: unknown }>(event);
	return json(await createOrganization(db, env, actor, body), { status: 201 });
});
