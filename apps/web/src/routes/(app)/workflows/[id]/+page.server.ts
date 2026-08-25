import { error } from '@sveltejs/kit';
import { listContextItemsForStates } from '$lib/server/api/context';
import { ApiFail } from '$lib/server/api/core';
import { listProjects } from '$lib/server/api/projects';
import { loadWorkflow, loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const workflow = await loadWorkflow(db, userId, params.id).catch((e) => {
		error(e instanceof ApiFail ? e.status : 500, 'Not found');
	});
	const [contextItems, projects, workflows] = await Promise.all([
		listContextItemsForStates(db, userId, workflow.states.map((s) => s.id)),
		listProjects(db, userId),
		loadWorkflows(db, userId)
	]);
	return {
		workflow,
		// Issue-anchored items stay on their issue's page.
		contextItems: contextItems.filter((i) => i.scope.issue_id === null),
		projects,
		workflows
	};
};
