import { error } from '@sveltejs/kit';
import { listContextItems } from '$lib/server/api/context';
import { ApiFail } from '$lib/server/api/core';
import { listIssues } from '$lib/server/api/issues';
import { getProject } from '$lib/server/api/projects';
import { listSchedules } from '$lib/server/api/schedules';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;

	const project = await getProject(db, userId, params.id).catch((e) => {
		error(e instanceof ApiFail ? e.status : 500, 'Not found');
	});
	const showDone = url.searchParams.get('done') === '1';
	const [{ items: issues }, workflows, { items: schedules }, { items: contextItems }] =
		await Promise.all([
			listIssues(db, userId, { projectId: project.id, hideDone: !showDone }, { cursor: null, limit: 100 }),
			loadWorkflows(db, userId),
			listSchedules(db, userId, { projectId: project.id }, { cursor: null, limit: 100 }),
			listContextItems(db, userId, { project: project.id }, { cursor: null, limit: 100 })
		]);
	return {
		project,
		issues,
		workflows,
		schedules,
		// Issue-anchored items appear only on their issue's page (and the
		// Context tab) — they are that issue's business.
		contextItems: contextItems.filter((i) => i.scope.issue_id === null),
		showDone
	};
};
