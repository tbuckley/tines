import { json } from '@sveltejs/kit';
import type { AddIssueLinkRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { addIssueLink } from '$lib/server/api/issue-links';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<AddIssueLinkRequest>(event);
	const link = await addIssueLink(db, env, actor, event.params.id, body);
	return json(link, { status: 201 });
});
