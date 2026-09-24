import { json } from '@sveltejs/kit';
import type { ContextItem, CreateContextItemRequest, ListResponse } from '@tines/shared';
import { createContextItem, listContextItems } from '$lib/server/api/context';
import {
	api,
	apiContext,
	encodeCursor,
	notFound,
	readArchived,
	readJson,
	readPage
} from '$lib/server/api/core';
import {
	actorForContextScope,
	contextScopeProject,
	memberScopeAllowed,
	redactForMember
} from '$lib/server/api/member-context';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor: requester } = await apiContext(event);
	const page = readPage(event);
	const params = event.url.searchParams;
	// A member lists a shared project's (or shared issue's) own items; the
	// owner's global and other-project items are filtered out below.
	const sharedScope = params.get('issue')
		? await contextScopeProject(db, { issue_id: params.get('issue') })
		: params.get('project');
	const actor = await actorForContextScope(db, requester, sharedScope).catch(() => requester);
	const { items, hasMore } = await listContextItems(
		db,
		actor,
		{
			kind: params.get('kind') ?? undefined,
			project: params.get('project') ?? undefined,
			state: params.get('state') ?? undefined,
			issue: params.get('issue') ?? undefined,
			label: params.get('label') ?? undefined,
			q: params.get('q') ?? undefined,
			exact: ['1', 'true'].includes(params.get('exact') ?? ''),
			archived: readArchived(params)
		},
		page
	);
	const visible = actor.member
		? (
				await Promise.all(
					items.map(async (item) =>
						(await memberScopeAllowed(db, actor, item.scope)) ? redactForMember(actor, item) : null
					)
				)
			).filter((item) => item !== null)
		: items;
	const last = items[items.length - 1];
	const body: ListResponse<ContextItem> = {
		items: visible,
		// The list orders by updated_at; the cursor's timestamp slot carries it.
		next_cursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null
	};
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	const body = await readJson<CreateContextItemRequest>(event);
	const actor = await actorForContextScope(
		db,
		requester,
		await contextScopeProject(db, { project_id: body.project_id, issue_id: body.issue_id })
	);
	if (actor.member && body.project_id && body.project_id !== actor.member.projectId)
		throw notFound();
	const item = await createContextItem(db, env, actor, body);
	return json(redactForMember(actor, item), { status: 201 });
});
