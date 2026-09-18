import { json } from '@sveltejs/kit';
import type { ListStartersResponse } from '@tines/shared';
import { api, apiContext } from '$lib/server/api/core';
import { listStarters } from '$lib/server/api/starters';
import type { RequestHandler } from './$types';

/**
 * The starter menu, for the "start from" chooser and the CLI. Static content,
 * so it only needs the caller to be authenticated — and deliberately not
 * control-plane, since a run key may already create projects, workflows and
 * context by hand.
 *
 * A static sibling of `projects/[id]`, which resolves by id only: no shadowing.
 */
export const GET: RequestHandler = api(async (event) => {
	await apiContext(event);
	const body: ListStartersResponse = { items: listStarters() };
	return json(body);
});
