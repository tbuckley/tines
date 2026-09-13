import { json } from '@sveltejs/kit';
import type { LaunchPromptResponse } from '@tines/shared';
import { listArtifacts } from '$lib/server/api/artifacts';
import {
	buildLaunchPrompt,
	buildResumePrompt,
	effectiveContextForIssue
} from '$lib/server/api/context';
import { api, apiContext } from '$lib/server/api/core';
import { getIssueDetail } from '$lib/server/api/issues';
import { listLabels } from '$lib/server/api/labels';
import type { RequestHandler } from './$types';

/**
 * Launch prompt: the stitched context plus the generated issue block. A pure
 * formatter over the context response, the issue read, and the artifact list.
 *
 * `?resume=1` renders the continuation form instead: the reduced message a
 * resumed conversation needs (current stage contract, journal and the issue
 * block), without the global and project prompts it already carries. The
 * managed adapter asks for it when it is continuing a kept session.
 */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const [issue, context, artifacts, labels] = await Promise.all([
		getIssueDetail(db, actor.userId, { id: event.params.id }, { round: true }),
		effectiveContextForIssue(db, actor.userId, event.params.id),
		listArtifacts(db, actor.userId, event.params.id),
		listLabels(db, actor.userId)
	]);
	const labelNames = labels.map((l) => l.name);
	const body: LaunchPromptResponse = {
		text:
			event.url.searchParams.get('resume') === '1'
				? buildResumePrompt(context, issue, artifacts, labelNames)
				: buildLaunchPrompt(context, issue, artifacts, labelNames)
	};
	return json(body);
});
