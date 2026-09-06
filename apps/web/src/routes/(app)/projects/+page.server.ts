import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	// Both project halves come from the app layout; the grid is the one list
	// that renders the archived one.
	const workflows = await loadWorkflows(db, userId);
	return { showArchived: url.searchParams.get('archived') === '1', workflows };
};
