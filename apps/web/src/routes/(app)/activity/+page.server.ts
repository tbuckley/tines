import { encodeCursor } from '$lib/server/api/core';
import {
	applyEventWindow,
	eventTimeParam,
	eventQuery,
	serializeEvent
} from '$lib/server/api/events';
import { getDb } from '$lib/server/db';
import { sessionActor } from '$lib/server/api/core';
import { listSharedEvents } from '$lib/server/api/shared-events';
import { resolvePageFocus } from '$lib/server/page-focus';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ locals, platform, url, depends }) => {
	depends('app:preferences');
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const actor = sessionActor(locals.user!);
	const { focusId, notice } = await resolvePageFocus(db, platform!.env, userId, url);

	const type = url.searchParams.get('type') ?? undefined;

	const since = eventTimeParam(url.searchParams, 'since');
	const until = eventTimeParam(url.searchParams, 'until');
	const state = url.searchParams.get('state') ?? undefined;
	let q = applyEventWindow(eventQuery(db, userId), { since, until, state });
	if (focusId) q = q.where('event.project_id', '=', focusId);
	if (type) q = q.where('event.type', '=', type);

	const rows = await q
		.orderBy('event.created_at desc')
		.orderBy('event.id desc')
		.limit(PAGE_SIZE + 1)
		.execute();

	const shared = await listSharedEvents(db, actor, {
		projectId: focusId ?? undefined,
		type: type ? [type] : undefined,
		since,
		until,
		state,
		limit: PAGE_SIZE
	});
	const merged = [...rows.slice(0, PAGE_SIZE).map(serializeEvent), ...shared.items].sort(
		(a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id)
	);
	const events = merged.slice(0, PAGE_SIZE);
	const last = events[events.length - 1];
	return {
		events,
		nextCursor:
			rows.length > PAGE_SIZE || shared.hasMore || merged.length > PAGE_SIZE
				? last
					? encodeCursor(last.created_at, last.id)
					: null
				: null,
		focusId,
		notice,
		filters: { type: type ?? '', since, until, state }
	};
};
