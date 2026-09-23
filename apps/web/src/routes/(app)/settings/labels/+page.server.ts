import { listLabelsInternal } from '$lib/server/api/labels';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const db = getDb(platform!.env);
	return { labels: await listLabelsInternal(db, locals.user!.id) };
};
