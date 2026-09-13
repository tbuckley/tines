import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
	PUBLICATION_RESPONSE_HEADERS,
	resolvePublicSnapshot
} from '$lib/server/publications/public';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform, setHeaders }) => {
	for (const [name, value] of Object.entries(PUBLICATION_RESPONSE_HEADERS))
		setHeaders({ [name]: value });
	const snapshot = await resolvePublicSnapshot(getDb(platform!.env), params.snapshotId);
	if (!snapshot) error(404, 'This publication is not available.');
	return { snapshot };
};
