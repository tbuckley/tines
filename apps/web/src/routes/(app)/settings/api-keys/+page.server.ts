import { listApiKeys } from '$lib/server/api/apikeys';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const db = getDb(platform!.env);
	return { keys: await listApiKeys(db, locals.user!.id) };
};
