import { listLabels } from '$lib/server/api/labels';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const labels = await listLabels(getDb(platform!.env), locals.user!.id);
	return { labels };
};
