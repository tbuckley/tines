import { error } from '@sveltejs/kit';
import { ApiFail } from '$lib/server/api/core';
import { listIssues } from '$lib/server/api/issues';
import { getProject } from '$lib/server/api/projects';
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
	const [{ items: issues }, workflows] = await Promise.all([
		listIssues(db, userId, { projectId: project.id, hideDone: !showDone }, { cursor: null, limit: 100 }),
		loadWorkflows(db, userId)
	]);
	return { project, issues, workflows, showDone };
};
