import { getDb } from '$lib/server/db';
import { listPublications } from '$lib/server/publications/publish';
import { publicationConfig } from '$lib/server/publications/config';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const env = platform!.env;
	const actor = {
		userId: locals.user!.id,
		userName: locals.user!.name,
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true,
		agentRunId: null
	};
	return {
		publications: await listPublications(getDb(env), env, actor),
		creation: publicationConfig(env)
	};
};
