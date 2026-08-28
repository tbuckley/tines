import { redirect } from '@sveltejs/kit';
import { listProjects } from '$lib/server/api/projects';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, platform }) => {
	if (!locals.user) redirect(302, '/');

	// Projects and workflows are needed by nearly every page (filters, modals,
	// editors) and change rarely. Loading them here means client-side
	// navigations between pages don't refetch them: a layout load only re-runs
	// on invalidation — and every mutation path already calls invalidateAll().
	const db = getDb(platform!.env);
	const [projects, workflows] = await Promise.all([
		listProjects(db, locals.user.id),
		loadWorkflows(db, locals.user.id)
	]);

	return { user: locals.user, projects, workflows };
};
