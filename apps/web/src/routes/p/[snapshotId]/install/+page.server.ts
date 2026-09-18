import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { resolvePublicSnapshot } from '$lib/server/publications/public';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform, locals }) => {
	const snapshot = await resolvePublicSnapshot(getDb(platform!.env), params.snapshotId);
	const destination = snapshot?.snapshot_id;
	if (!destination) redirect(303, `/p/${encodeURIComponent(params.snapshotId)}`);
	if (locals.user)
		redirect(303, `/workflows/import?publication=${encodeURIComponent(destination)}`);
	redirect(303, `/p/${encodeURIComponent(destination)}?install=1`);
};
