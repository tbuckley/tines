import { getDb } from '$lib/server/db';
import { getPublisherSuspension, listPublications } from '$lib/server/publications/publish';
import { hostModerationConfig, publicationConfig } from '$lib/server/publications/config';
import { readPage } from '$lib/server/api/core';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { locals, platform, url } = event;
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
		listPublications(db, env, actor, { page: readPage(event, { defaultLimit: 100 }) }),
		getPublisherSuspension(db, actor)
	]);
	return {
		publications: publications.items,
		nextCursor: publications.next_cursor,
		firstHref: url.pathname,
		suspension,
		creation: publicationConfig(env),
		appealContact: hostModerationConfig(env).appealContact
	};
};
