import { listContextItems } from '$lib/server/api/context';
import { listProjects } from '$lib/server/api/projects';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;

	const filters = {
		kind: url.searchParams.get('kind') ?? undefined,
		project: url.searchParams.get('project') ?? undefined,
		q: url.searchParams.get('q') ?? undefined
	};
	const [{ items }, projects, workflows] = await Promise.all([
		listContextItems(db, userId, filters, { cursor: null, limit: 100 }),
		listProjects(db, userId),
		loadWorkflows(db, userId)
	]);
	return { items, projects, workflows, filters };
};
