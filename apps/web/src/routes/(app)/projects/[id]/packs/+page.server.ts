import { error } from '@sveltejs/kit';
import { ApiFail, sessionActor } from '$lib/server/api/core';
import { packProject } from '$lib/server/api/packs/access';
import { listProjectPacks } from '$lib/server/api/packs/views';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params }) => {
	const db = getDb(platform!.env);
	const actor = sessionActor({ id: locals.user!.id, name: locals.user!.name });
	const pp = await packProject(db, actor, params.id, 'read', 'pack.read').catch((e) => {
		if (e instanceof ApiFail) error(e.status, e.message);
		throw e;
	});
	return {
		project: {
			id: pp.project.id,
			name: pp.project.name,
			archived: pp.project.archived_at !== null
		},
		packs: await listProjectPacks(db, params.id, pp.personId)
	};
};
