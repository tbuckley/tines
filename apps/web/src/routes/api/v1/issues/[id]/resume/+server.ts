import { json } from '@sveltejs/kit';
import { api, apiContext } from '$lib/server/api/core';
import { resumeIssue } from '$lib/server/api/issues';
import { scopeIssueLinksForMember } from '$lib/server/api/member-context';
import { actorForIssue } from '$lib/server/api/project-access';
import type { RequestHandler } from './$types';

/**
 * Un-park an issue. Run keys never reach this handler: the path is on the
 * control-plane fence (403 from auth) — an agent must not un-park itself.
 */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor: requester, effects } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	const issue = await resumeIssue(db, env, actor, effects, event.params.id);
	return json(await scopeIssueLinksForMember(db, actor, issue));
});
