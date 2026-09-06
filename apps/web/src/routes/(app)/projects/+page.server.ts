import { partitionProjects } from '$lib/archived';
import { listProjects } from '$lib/server/api/projects';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	// The grid is the one list that may show archived projects, so it asks for
	// them all and splits them here; everything else takes the hiding default.
	const [projects, workflows] = await Promise.all([
		listProjects(db, userId, { archived: 'all' }),
		loadWorkflows(db, userId)
	]);
	const { live, archived } = partitionProjects(projects);
	return { live, archived, showArchived: url.searchParams.get('archived') === '1', workflows };
};
