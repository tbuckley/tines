import { error } from '@sveltejs/kit';
import { effectiveContextForIssue, listContextItems } from '$lib/server/api/context';
import { eventQuery, serializeEvent } from '$lib/server/api/events';
import { getIssueDetail } from '$lib/server/api/issues';
import { listProjects } from '$lib/server/api/projects';
import { listRunners } from '$lib/server/api/runners';
import { listRuns } from '$lib/server/api/runs';
import { loadWorkflows } from '$lib/server/api/workflows';
import { explainDispatch } from '$lib/server/supervisor/explain';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;

	const number = Number.parseInt(params.number, 10);
	if (!Number.isFinite(number)) error(404, 'Not found');

	// URLs address projects by name; resolve to the newest match.
	const project = await db
		.selectFrom('project')
		.select(['id'])
		.where('user_id', '=', userId)
		.where('name', '=', params.project)
		.orderBy('created_at desc')
		.executeTakeFirst();
	if (!project) error(404, 'Not found');

	const issue = await getIssueDetail(db, userId, { projectId: project.id, number }).catch(() => {
		error(404, 'Not found');
	});

	const [eventRows, workflows, projects, contextItems, effectiveContext, dispatch, issueRuns, runners] = await Promise.all([
		eventQuery(db, userId)
			.where('event.issue_id', '=', issue.id)
			.orderBy('event.created_at desc')
			.orderBy('event.id desc')
			.limit(100)
			.execute(),
		loadWorkflows(db, userId),
		listProjects(db, userId),
		// Items whose scope includes this issue (all issue-anchored shapes).
		listContextItems(db, userId, { issue: issue.id }, { cursor: null, limit: 100 }),
		// Display-only bundle: the panel shows skill file counts, never their
		// contents, which can run to 100KB per skill on every page load.
		effectiveContextForIssue(db, userId, issue.id, { skillFiles: false }),
		explainDispatch(db, userId, issue.id),
		listRuns(db, userId, { issue: issue.id }, { cursor: null, limit: 20 }),
		listRunners(db, userId)
	]);

	return {
		issue,
		events: eventRows.map(serializeEvent),
		workflows,
		projects,
		contextItems: contextItems.items,
		effectiveContext,
		dispatch,
		issueRuns: issueRuns.items,
		runners
	};
};
