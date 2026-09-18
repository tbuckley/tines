import { listLabels } from '$lib/server/api/labels';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const [workflows, labels] = await Promise.all([
		loadWorkflows(db, userId),
		listLabels(db, userId)
	]);
	return { workflows, labels };
};
