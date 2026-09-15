import { getDb } from '$lib/server/db';
import { listModerationCases } from '$lib/server/publications/moderation';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const raw = url.searchParams.get('filter') ?? 'unread';
	const filter = ['unread', 'open', 'resolved', 'all'].includes(raw) ? raw : 'unread';
	const cursor = url.searchParams.get('cursor') ?? undefined;
	const result = await listModerationCases(
		getDb(platform!.env),
		platform!.env,
		{
			userId: locals.user!.id,
			userName: locals.user!.name,
			apiKeyId: null,
			apiKeyName: null,
			viaSession: true,
			agentRunId: null
		},
		{ filter: filter as 'unread' | 'open' | 'resolved' | 'all', cursor }
	);
	return { ...result, filter };
};
