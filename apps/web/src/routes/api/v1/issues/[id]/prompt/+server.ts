import { json } from '@sveltejs/kit';
import type { LaunchPromptResponse } from '@tines/shared';
import { buildLaunchPrompt, effectiveContextForIssue } from '$lib/server/api/context';
import { api, apiContext } from '$lib/server/api/core';
import { getIssueDetail } from '$lib/server/api/issues';
import type { RequestHandler } from './$types';

/**
 * Launch prompt: the stitched context plus the generated issue block. A pure
 * formatter over the context response and the issue read.
 */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const [issue, context] = await Promise.all([
		getIssueDetail(db, actor.userId, { id: event.params.id }),
		effectiveContextForIssue(db, actor.userId, event.params.id)
	]);
	const body: LaunchPromptResponse = { text: buildLaunchPrompt(context.prompt.text, issue) };
	return json(body);
});
