import { error } from '@sveltejs/kit';
import { ApiFail } from '$lib/server/api/core';
import { listIssues } from '$lib/server/api/issues';
import { getProject } from '$lib/server/api/projects';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;

	const showDone = url.searchParams.get('done') === '1';
	// Ready already implies not-done; the "show done" param just parks while it is on.
	const ready = url.searchParams.get('ready') === '1';

	// Only the project header and its issue list block the page render. The
	// secondary panels — schedules, context, agent routing — fetch client-side
	// after hydration (see $lib/deferred.svelte.ts); workflows come from the
	// (app) layout load. Both queries address the project by params.id, so
	// they run together.
	const [project, { items: issues }] = await Promise.all([
		getProject(db, userId, params.id).catch((e) => {
			error(e instanceof ApiFail ? e.status : 500, 'Not found');
		}),
		listIssues(
			db,
			userId,
			{ projectId: params.id, hideDone: !showDone, ready },
			{ cursor: null, limit: 100 }
		)
	]);

	return { project, issues, showDone, ready };
};
