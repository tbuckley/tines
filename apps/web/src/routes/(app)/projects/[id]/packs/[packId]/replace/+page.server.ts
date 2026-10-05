import { error } from '@sveltejs/kit';
import { ApiFail, sessionActor } from '$lib/server/api/core';
import { loadPack, packProject } from '$lib/server/api/packs/access';
import { workflowInputOptions } from '$lib/server/api/packs/views';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params, url }) => {
	const db = getDb(platform!.env);
	const actor = sessionActor({ id: locals.user!.id, name: locals.user!.name });
	const fail = (e: unknown) => {
		if (e instanceof ApiFail) error(e.status, e.message);
		throw e;
	};
	const pp = await packProject(db, actor, params.id, 'read', 'pack.read').catch(fail);
	const pack = await loadPack(db, params.id, params.packId).catch(fail);
	return {
		project: { id: pp.project.id, name: pp.project.name },
		pack: {
			id: pack.id,
			name: pack.name,
			kind: pack.kind,
			version: pack.version,
			hasSource: pack.source_pack_id !== null
		},
		fromSource: url.searchParams.get('from') === 'source',
		workflowOptions: await workflowInputOptions(db, pp.actor.userId, params.id)
	};
};
