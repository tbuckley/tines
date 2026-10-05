import { sessionActor } from '$lib/server/api/core';
import { listOrganizations } from '$lib/server/api/organizations';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const actor = sessionActor({ id: locals.user!.id, name: locals.user!.name });
	return { organizations: await listOrganizations(getDb(platform!.env), actor) };
};
