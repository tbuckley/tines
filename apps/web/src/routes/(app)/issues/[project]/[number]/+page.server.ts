import { error } from '@sveltejs/kit';
import { eventQuery, serializeEvent } from '$lib/server/api/events';
import { getIssueDetail } from '$lib/server/api/issues';
import { loadWorkflows } from '$lib/server/api/workflows';
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

	const [eventRows, workflows] = await Promise.all([
		eventQuery(db, userId)
			.where('event.issue_id', '=', issue.id)
			.orderBy('event.created_at desc')
			.orderBy('event.id desc')
			.limit(100)
			.execute(),
		loadWorkflows(db, userId)
	]);

	return { issue, events: eventRows.map(serializeEvent), workflows };
};
