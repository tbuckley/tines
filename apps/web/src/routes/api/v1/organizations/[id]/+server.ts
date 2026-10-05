import { json } from '@sveltejs/kit';
import { api, apiContext, readJson, readOptionalJson } from '$lib/server/api/core';
import {
	deleteOrganization,
	getOrganization,
	renameOrganization
} from '$lib/server/api/organizations';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getOrganization(db, actor, event.params.id));
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<{ name?: unknown; expected_revision?: unknown }>(event);
	return json(await renameOrganization(db, env, actor, event.params.id, body));
});

/** Deletes a shared organization: `{ confirm_name }` must be its name. */
export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readOptionalJson<{ confirm_name?: unknown }>(event);
	return json(await deleteOrganization(db, env, actor, event.params.id, body));
});
