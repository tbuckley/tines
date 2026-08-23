import { listIssues } from '$lib/server/api/issues';
import { listProjects } from '$lib/server/api/projects';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;

	const filters = {
		project: url.searchParams.get('project') ?? undefined,
		state: url.searchParams.get('state') ?? undefined,
		category: url.searchParams.get('category') ?? undefined,
		showDone: url.searchParams.get('done') === '1'
	};

	const [{ items: issues }, projects, workflows] = await Promise.all([
		listIssues(
			db,
			userId,
			{
				project: filters.project,
				state: filters.state,
				category: filters.category,
				hideDone: !filters.showDone && !filters.category && !filters.state
			},
			{ cursor: null, limit: 100 }
		),
		listProjects(db, userId),
		loadWorkflows(db, userId)
	]);

	return { issues, projects, workflows, filters };
};
