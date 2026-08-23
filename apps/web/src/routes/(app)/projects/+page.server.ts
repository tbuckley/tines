import { listProjects } from '$lib/server/api/projects';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const [projects, workflows] = await Promise.all([
		listProjects(db, userId),
		loadWorkflows(db, userId)
	]);
	return { projects, workflows };
};
