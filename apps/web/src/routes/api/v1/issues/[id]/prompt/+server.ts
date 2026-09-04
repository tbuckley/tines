import { json } from '@sveltejs/kit';
import type { LaunchPromptResponse } from '@tines/shared';
import { listArtifacts } from '$lib/server/api/artifacts';
import { buildLaunchPrompt, effectiveContextForIssue } from '$lib/server/api/context';
import { api, apiContext } from '$lib/server/api/core';
import { getIssueDetail } from '$lib/server/api/issues';
import { listLabels } from '$lib/server/api/labels';
import type { RequestHandler } from './$types';

/**
 * Launch prompt: the stitched context plus the generated issue block. A pure
 * formatter over the context response, the issue read, and the artifact list.
 */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const [issue, context, artifacts, labels] = await Promise.all([
		getIssueDetail(db, actor.userId, { id: event.params.id }),
		effectiveContextForIssue(db, actor.userId, event.params.id),
		listArtifacts(db, actor.userId, event.params.id),
		listLabels(db, actor.userId)
	]);
	const body: LaunchPromptResponse = {
		text: buildLaunchPrompt(
			context,
			issue,
			artifacts,
			labels.map((l) => l.name)
		)
	};
	return json(body);
});
