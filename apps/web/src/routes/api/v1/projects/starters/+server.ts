import { json } from '@sveltejs/kit';
import type { ListStartersResponse } from '@tines/shared';
import { api, apiContext } from '$lib/server/api/core';
import { listStarters } from '$lib/server/api/starters';
import { requireAccess } from '$lib/server/api/permissions';
import type { RequestHandler } from './$types';

/**
 * The starter menu, for the "start from" chooser and the CLI. It describes
 * shared workflow/context configuration, so it follows workspace reads.
 *
 * A static sibling of `projects/[id]`, which resolves by id only: no shadowing.
 */
export const GET: RequestHandler = api(async (event) => {
	const { actor } = await apiContext(event);
	requireAccess(actor, [{ domain: 'workspace', access: 'read' }], 'starter.read');
	const body: ListStartersResponse = { items: listStarters() };
	return json(body);
});
