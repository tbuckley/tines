import { error } from '@sveltejs/kit';
import { ApiFail } from '$lib/server/api/core';
import { loadWorkflow } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params }) => {
	const db = getDb(platform!.env);
	const workflow = await loadWorkflow(db, locals.user!.id, params.id).catch((e) => {
		error(e instanceof ApiFail ? e.status : 500, 'Not found');
	});
	return { workflow };
};
