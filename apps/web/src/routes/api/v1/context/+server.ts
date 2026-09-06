import { json } from '@sveltejs/kit';
import type { ContextItem, CreateContextItemRequest, ListResponse } from '@tines/shared';
import { createContextItem, listContextItems } from '$lib/server/api/context';
import {
	api,
	apiContext,
	encodeCursor,
	readArchived,
	readJson,
	readPage
} from '$lib/server/api/core';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const page = readPage(event);
	const params = event.url.searchParams;
	const { items, hasMore } = await listContextItems(
		db,
		actor.userId,
		{
			kind: params.get('kind') ?? undefined,
			project: params.get('project') ?? undefined,
			state: params.get('state') ?? undefined,
			issue: params.get('issue') ?? undefined,
			q: params.get('q') ?? undefined,
			exact: ['1', 'true'].includes(params.get('exact') ?? ''),
			archived: readArchived(params)
		},
		page
	);
	const last = items[items.length - 1];
	const body: ListResponse<ContextItem> = {
		items,
		// The list orders by updated_at; the cursor's timestamp slot carries it.
		next_cursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null
	};
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<CreateContextItemRequest>(event);
	return json(await createContextItem(db, env, actor, body), { status: 201 });
});
