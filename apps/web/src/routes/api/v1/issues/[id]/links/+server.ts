import { json } from '@sveltejs/kit';
import type { AddIssueLinkRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { addIssueLink } from '$lib/server/api/issue-links';
import { actorForIssue } from '$lib/server/api/project-access';
import { memberWriteRace } from '$lib/server/api/member-e2e-race';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor: requester, effects } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	const body = await readJson<AddIssueLinkRequest>(event);
	const link = await addIssueLink(
		db,
		env,
		actor,
		effects,
		event.params.id,
		body,
		memberWriteRace(event.request, db, actor, event.params.id)
	);
	return json(link, { status: 201 });
});
