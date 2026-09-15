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
	const publisherCursor = url.searchParams.get('publisher_cursor') ?? undefined;
	const [result, suspendedPublishers] = await Promise.all([
		listModerationCases(db, platform!.env, actor, {
			filter: filter as 'unread' | 'open' | 'resolved' | 'all',
			cursor
		}),
		listSuspendedPublishers(db, platform!.env, actor, { cursor: publisherCursor })
	]);
	return {
		...result,
		filter,
		suspendedPublishers: suspendedPublishers.items,
		publisher_next_cursor: suspendedPublishers.next_cursor
	};
};
