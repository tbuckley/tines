import { getDb } from '$lib/server/db';
import { getPublisherSuspension, listPublications } from '$lib/server/publications/publish';
import { hostModerationConfig, publicationConfig } from '$lib/server/publications/config';
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
	const db = getDb(env);
	const [publications, suspension] = await Promise.all([
		listPublications(db, env, actor),
		getPublisherSuspension(db, actor)
	]);
	return {
		publications,
		suspension,
		creation: publicationConfig(env),
		appealContact: hostModerationConfig(env).appealContact
	};
};
