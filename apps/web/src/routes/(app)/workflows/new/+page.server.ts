import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	// The editor's Inherits-from picker offers every state the user can see,
	// so even a workflow that does not exist yet needs the whole library.
	return { workflows: await loadWorkflows(getDb(platform!.env), locals.user!.id) };
};
