import { countRunKeys, listApiKeys, REVOKED_RUN_KEY_LIMIT } from '$lib/server/api/apikeys';
import { getDb } from '$lib/server/db';
import { FULL_API_KEY_PERMISSIONS } from '@tines/shared';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const actor = {
		userId,
		userName: locals.user!.name,
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true,
		permissions: FULL_API_KEY_PERMISSIONS,
		runRestriction: null
	};
	// Revoked run keys are opt-in: one is minted per agent run and never
	// deleted, so shipping them all would grow the page by a row per run.
	const showRevoked = url.searchParams.get('revoked') === '1';
	const [keys, runKeyCounts] = await Promise.all([
		listApiKeys(db, actor, { runKeys: showRevoked ? 'all' : 'active' }),
		countRunKeys(db, userId)
	]);
	return { keys, runKeyCounts, showRevoked, revokedRunKeyLimit: REVOKED_RUN_KEY_LIMIT };
};
