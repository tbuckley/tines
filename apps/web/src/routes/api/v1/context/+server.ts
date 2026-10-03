import { json } from '@sveltejs/kit';
import type { ContextItem, CreateContextItemRequest, ListResponse } from '@tines/shared';
import { createContextItem, listContextItems } from '$lib/server/api/context';
import {
	ApiFail,
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
	listSharedContextItems,
	memberScopeAllowed,
	mergeContextPages,
	redactForMember
} from '$lib/server/api/member-context';
import { resolveAccessibleProjectRef } from '$lib/server/api/project-access';
import { memberWriteRace } from '$lib/server/api/member-e2e-race';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor: requester } = await apiContext(event);
	const page = readPage(event);
	const params = event.url.searchParams;
	// A project may be named by id or by name; a name resolves across the
	// caller's own and shared projects (as GET /issues does), so a member can
	// name a shared project either way. An unknown ref keeps the raw value and
	// lists nothing.
	const namedProject = params.get('project');
	let project = namedProject ?? undefined;
	if (namedProject) {
		try {
			project = await resolveAccessibleProjectRef(db, requester, namedProject);
		} catch (error) {
			if (error instanceof ApiFail && error.code === 'ambiguous_project') throw error;
		}
	}
	const issue = params.get('issue') ?? undefined;
	const filters = {
		kind: params.get('kind') ?? undefined,
		project,
		state: params.get('state') ?? undefined,
		issue,
		label: params.get('label') ?? undefined,
		q: params.get('q') ?? undefined,
		exact: ['1', 'true'].includes(params.get('exact') ?? ''),
		archived: readArchived(params)
	};
	// A member lists a shared project's (or shared issue's) own items; the
	// owner's global and other-project items are filtered out below.
	const sharedScope = issue
		? await contextScopeProject(db, { issue_id: issue })
		: (project ?? null);
	const actor = await actorForContextScope(db, requester, sharedScope).catch(() => requester);
	const own = await listContextItems(db, actor, filters, page);
	const visible = actor.member
		? (
				await Promise.all(
					own.items.map(async (item) =>
						(await memberScopeAllowed(db, actor, item.scope)) ? redactForMember(actor, item) : null
					)
				)
			).filter((item) => item !== null)
		: own.items;
	// With no place named, the list is the caller's own account plus the items
	// of every project shared with them. Each source returns its first `limit`
	// rows after the cursor, so the merge pages without gaps or repeats.
	const unionShared = !project && !issue && !filters.exact && !requester.agentRunId;
	const shared = unionShared
		? await listSharedContextItems(db, requester, filters, page)
		: { items: [], hasMore: false };
	const merged = unionShared ? mergeContextPages([...visible, ...shared.items]) : visible;
	const items = merged.slice(0, page.limit);
	const hasMore = merged.length > page.limit || own.hasMore || shared.hasMore;
	// The cursor follows the last row read: of the cut when merging, of the
	// unfiltered page otherwise (a member's post-filter may drop its tail).
	const last = unionShared ? items[items.length - 1] : own.items[own.items.length - 1];
	const body: ListResponse<ContextItem> = {
		items,
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
	const item = await createContextItem(
		db,
		env,
		actor,
		body,
		memberWriteRace(event.request, db, actor)
	);
	return json(redactForMember(actor, item), { status: 201 });
});
