import { error } from '@sveltejs/kit';
import { ApiFail, sessionActor } from '$lib/server/api/core';
import { packProject } from '$lib/server/api/packs/access';
import { listSourceCandidates } from '$lib/server/api/packs/install';
import { workflowInputOptions } from '$lib/server/api/packs/views';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params }) => {
	const db = getDb(platform!.env);
	const actor = sessionActor({ id: locals.user!.id, name: locals.user!.name });
	const pp = await packProject(db, actor, params.id, 'read', 'pack.read').catch((e) => {
		if (e instanceof ApiFail) error(e.status, e.message);
		throw e;
	});
	const [workflowOptions, sources] = await Promise.all([
		workflowInputOptions(db, pp.actor.userId, params.id),
		listSourceCandidates(db, actor, params.id)
	]);
	return {
		project: { id: pp.project.id, name: pp.project.name },
		workflowOptions,
		sources
	};
};
