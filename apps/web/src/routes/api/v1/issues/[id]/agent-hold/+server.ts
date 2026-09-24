import { json } from '@sveltejs/kit';
import type { AgentHoldRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { writeIssueHold } from '$lib/server/api/issue-controls';
import { actorForIssue } from '$lib/server/api/project-access';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = api(async (event) => {
	const { db, env, actor: requester, effects } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	const body = await readJson<AgentHoldRequest>(event);
	const receipt = await writeIssueHold(db, env, actor, event.params.id, body);
	effects.signalDispatch();
	return json(receipt);
});
