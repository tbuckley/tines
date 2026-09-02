import { error } from '@sveltejs/kit';
import { truncate } from '$lib/format';
import { listContextItemsForStates } from '$lib/server/api/context';
import { ApiFail } from '$lib/server/api/core';
import { listProjects } from '$lib/server/api/projects';
import { listRoutingRules } from '$lib/server/api/routing';
import { loadWorkflow, loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const workflow = await loadWorkflow(db, userId, params.id).catch((e) => {
		const status = e instanceof ApiFail ? e.status : 500;
		error(
			status,
			status === 404 ? `No workflow has the ID “${truncate(params.id)}”.` : 'Not found'
		);
	});
	const [contextItems, projects, workflows, routingRules] = await Promise.all([
		listContextItemsForStates(
			db,
			userId,
			workflow.states.map((s) => s.id)
		),
		listProjects(db, userId),
		loadWorkflows(db, userId),
		listRoutingRules(db, userId)
	]);
	const stateIds = new Set(workflow.states.map((s) => s.id));
	return {
		workflow,
		// The inline agent-routing rows: rules scoped to this workflow's states.
		routingRules: routingRules.filter(
			(r) => r.scope.workflow_state_id !== null && stateIds.has(r.scope.workflow_state_id)
		),
		// Issue-anchored items stay on their issue's page.
		contextItems: contextItems.filter((i) => i.scope.issue_id === null),
		projects,
		workflows
	};
};
