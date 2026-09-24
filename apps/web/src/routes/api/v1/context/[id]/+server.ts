import { json } from '@sveltejs/kit';
import type { UpdateContextItemRequest } from '@tines/shared';
import { deleteContextItem, getContextItem, updateContextItem } from '$lib/server/api/context';
import { api, apiContext, notFound, readJson } from '$lib/server/api/core';
import {
	actorForContextItem,
	contextScopeProject,
	redactForMember
} from '$lib/server/api/member-context';
import type { RequestHandler } from './$types';

// Items in a shared project are the members' to work on too (member-context.ts).
export const GET: RequestHandler = api(async (event) => {
	const { db, actor: requester } = await apiContext(event);
	const actor = await actorForContextItem(db, requester, event.params.id);
	return json(redactForMember(actor, await getContextItem(db, actor, event.params.id)));
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	const actor = await actorForContextItem(db, requester, event.params.id);
	const body = await readJson<UpdateContextItemRequest>(event);
	// A member cannot move an item out of the shared project.
	if (
		actor.member &&
		(body.project_id !== undefined || body.issue_id !== undefined) &&
		(await contextScopeProject(db, {
			project_id: body.project_id,
			issue_id: body.issue_id
		})) !== actor.member.projectId
	)
		throw notFound();
	const item = await updateContextItem(db, env, actor, event.params.id, body);
	return json(redactForMember(actor, item));
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	const actor = await actorForContextItem(db, requester, event.params.id);
	await deleteContextItem(db, env, actor, event.params.id);
	return new Response(null, { status: 204 });
});
