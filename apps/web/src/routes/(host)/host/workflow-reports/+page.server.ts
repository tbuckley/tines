import { getDb } from '$lib/server/db';
import { listModerationCases, listSuspendedPublishers } from '$lib/server/publications/moderation';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const raw = url.searchParams.get('filter') ?? 'unread';
	const filter = ['unread', 'open', 'resolved', 'all'].includes(raw) ? raw : 'unread';
	const cursor = url.searchParams.get('cursor') ?? undefined;
	const actor = {
		userId: locals.user!.id,
		userName: locals.user!.name,
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true,
		agentRunId: null
	};
	const db = getDb(platform!.env);
	const [result, suspendedPublishers] = await Promise.all([
		listModerationCases(db, platform!.env, actor, {
			filter: filter as 'unread' | 'open' | 'resolved' | 'all',
			cursor
		}),
		listSuspendedPublishers(db, platform!.env, actor)
	]);
	return { ...result, filter, suspendedPublishers };
};
