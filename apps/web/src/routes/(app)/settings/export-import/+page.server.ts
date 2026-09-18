import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => ({
	workflows: await loadWorkflows(getDb(platform!.env), locals.user!.id)
});
