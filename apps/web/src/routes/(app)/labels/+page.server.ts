import { listLabelsInternal } from '$lib/server/api/labels';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const labels = await listLabelsInternal(getDb(platform!.env), locals.user!.id);
	return { labels };
};
