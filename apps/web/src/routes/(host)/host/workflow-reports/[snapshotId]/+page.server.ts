import { getDb } from '$lib/server/db';
import { inspectModerationSnapshot } from '$lib/server/publications/moderation';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params }) =>
	inspectModerationSnapshot(
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
		params.snapshotId
	);
