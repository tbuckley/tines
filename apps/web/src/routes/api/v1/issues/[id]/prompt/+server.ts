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
import { requireIssueAccess, type Requirement } from '$lib/server/api/permissions';
import { readSharedBundle } from '$lib/server/api/shared-execution-bundle';

const EXTRAS: Requirement[] = [
	{ domain: 'workspace', access: 'read' },
	{ domain: 'control_plane', access: 'read' }
];

/**
 * Launch prompt: the stitched context plus the generated issue block. A pure
 * formatter over the context response, the issue read, and the artifact list.
 *
 * `?resume=1` renders the continuation form instead: the reduced message a
 * resumed conversation needs (current stage contract, journal and the issue
 * block), without the global and project prompts it already carries. The
 * managed adapter asks for it when it is continuing a kept session.
 *
 * In a shared project (flag on) both forms render over the shared bundle's
 * guidance and issue inputs, for the owner and members alike.
 */
export const GET: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const resume = event.url.searchParams.get('resume') === '1';
	const shared = await readSharedBundle(env, db, actor, event.params.id, EXTRAS, {
		skillFiles: false
	});
	if (shared) {
		const { guidance, issue } = shared.bundle;
		const build = resume ? buildResumePrompt : buildLaunchPrompt;
		const body: LaunchPromptResponse = {
			text: build(guidance, issue.detail, issue.artifacts, issue.label_vocabulary)
		};
		return json(body);
	}
	await requireIssueAccess(db, actor, event.params.id, 'read', 'context.read', EXTRAS);
	const [issue, context, artifacts, labels] = await Promise.all([
		getIssueDetail(
			db,
			actor.userId,
			{ id: event.params.id },
			{ round: true, launchComments: true }
		),
		effectiveContextForIssue(db, actor.userId, event.params.id),
		listArtifacts(db, actor.userId, event.params.id),
		listLabels(db, actor)
	]);
	const labelNames = labels.map((l) => l.name);
	const body: LaunchPromptResponse = {
		text: resume
			? buildResumePrompt(context, issue, artifacts, labelNames)
			: buildLaunchPrompt(context, issue, artifacts, labelNames)
	};
	return json(body);
});
