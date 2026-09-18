import { error } from '@sveltejs/kit';
import { sql } from 'kysely';
import { eventQuery, serializeEvent } from '$lib/server/api/events';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;

/** Marker evidence has explicit IDs, independent of the saved Activity focus. */
export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const ids = [...new Set(url.searchParams.getAll('event').filter(Boolean))];
	const offset = Number(url.searchParams.get('offset') ?? 0);
	if (!Number.isSafeInteger(offset) || offset < 0) error(400, 'Invalid event offset');
	const db = getDb(platform!.env);
	// One bound JSON parameter avoids D1's bind limit for large marker batches.
	// eventQuery always requires event.user_id = the signed-in user.
	const rows = ids.length
		? await eventQuery(db, locals.user!.id)
				.where('event.id', 'in', sql<string>`(SELECT value FROM json_each(${JSON.stringify(ids)}))`)
				.orderBy('event.created_at desc')
				.orderBy('event.id desc')
				.limit(PAGE_SIZE + 1)
				.offset(offset)
				.execute()
		: [];
	const next = new URLSearchParams(url.searchParams);
	next.set('offset', String(offset + PAGE_SIZE));
	return {
		events: rows.slice(0, PAGE_SIZE).map(serializeEvent),
		nextHref: rows.length > PAGE_SIZE ? `/activity/recorded?${next}` : null
	};
};
