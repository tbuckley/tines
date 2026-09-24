import { json } from '@sveltejs/kit';
import type { AppendContextRequest } from '@tines/shared';
import { appendContextItem } from '$lib/server/api/context';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { actorForContextItem } from '$lib/server/api/member-context';
import type { RequestHandler } from './$types';

/** Atomic append to a prompt item's body (blank-line separated). */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	const actor = await actorForContextItem(db, requester, event.params.id);
	const body = await readJson<AppendContextRequest>(event);
	return json(await appendContextItem(db, env, actor, event.params.id, body));
});
