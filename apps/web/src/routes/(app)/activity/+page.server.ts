import { encodeCursor } from '$lib/server/api/core';
import { eventQuery, serializeEvent } from '$lib/server/api/events';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;

	const project = url.searchParams.get('project') ?? undefined;
	const type = url.searchParams.get('type') ?? undefined;

	let q = eventQuery(db, userId);
	if (project) {
		q = q.where((eb) => eb.or([eb('event.project_id', '=', project), eb('project.name', '=', project)]));
	}
	if (type) q = q.where('event.type', '=', type);

	// projects come from the (app) layout load.
	const rows = await q
		.orderBy('event.created_at desc')
		.orderBy('event.id desc')
		.limit(PAGE_SIZE + 1)
		.execute();

	const events = rows.slice(0, PAGE_SIZE).map(serializeEvent);
	const last = events[events.length - 1];
	return {
		events,
		nextCursor: rows.length > PAGE_SIZE && last ? encodeCursor(last.created_at, last.id) : null,
		filters: { project: project ?? '', type: type ?? '' }
	};
};
