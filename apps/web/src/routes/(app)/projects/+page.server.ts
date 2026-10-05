import { listStarters } from '$lib/server/api/starters';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import { sessionActor } from '$lib/server/api/core';
import { listOrganizations } from '$lib/server/api/organizations';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	// Both project halves come from the app layout; the grid is the one list
	// that renders the archived one.
	const [workflows, organizations] = await Promise.all([
		loadWorkflows(db, userId),
		listOrganizations(db, sessionActor({ id: userId, name: locals.user!.name }))
	]);
	return {
		organizations,
		showArchived: url.searchParams.get('archived') === '1',
		workflows,
		// The menu is pure data (no DB), so the New-project dialog never has to
		// fetch it and never has a loading or failure state.
		starters: listStarters()
	};
};
