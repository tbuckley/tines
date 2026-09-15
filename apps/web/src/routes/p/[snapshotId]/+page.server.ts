import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { resolvePublicSnapshot } from '$lib/server/publications/public';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform, locals, url }) => {
	const snapshot = await resolvePublicSnapshot(getDb(platform!.env), params.snapshotId);
	if (!snapshot) error(404, 'This publication is not available.');
	if (locals.user && url.searchParams.get('install') === '1')
		redirect(303, `/workflows/import?publication=${encodeURIComponent(snapshot.snapshot_id)}`);
	return { snapshot };
};
