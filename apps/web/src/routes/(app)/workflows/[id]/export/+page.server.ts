import { error } from '@sveltejs/kit';
import { exportWorkflowPackage } from '$lib/server/library/export';
import { loadWorkflow, loadWorkflows } from '$lib/server/api/workflows';
import { scheduleQuery, serializeSchedule } from '$lib/server/api/schedules';
import { ApiFail } from '$lib/server/api/core';
import { getDb } from '$lib/server/db';
import { publicationConfig } from '$lib/server/publications/config';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const workflow = await loadWorkflow(db, userId, params.id).catch((cause) => {
		error(cause instanceof ApiFail ? cause.status : 500, 'Workflow not found');
	});
	const allWorkflows = await loadWorkflows(db, userId);
	const owners = new Map(
		allWorkflows.flatMap((item) => item.states.map((state) => [state.id, item]))
	);
	const closure = [workflow];
	const closureIds = new Set([workflow.id]);
	for (const item of closure) {
		for (const state of item.states) {
			if (!state.inherits_from) continue;
			const dependency = owners.get(state.inherits_from);
			if (dependency && !closureIds.has(dependency.id)) {
				closureIds.add(dependency.id);
				closure.push(dependency);
			}
		}
	}
	const ordered = [
		workflow,
		...closure
			.filter((item) => item.id !== workflow.id)
			.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
	];
	const candidate = await exportWorkflowPackage(db, userId, workflow.id);
	const sourceStates = ordered.flatMap((item, workflowIndex) =>
		[...item.states]
			.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
			.map((state, stateIndex) => ({
				id: state.id,
				local_id: candidate.workflows[workflowIndex].states[stateIndex].id,
				name: state.name,
				workflow_name: item.name
			}))
	);
	const schedules = (await scheduleQuery(db, userId).execute())
		.map(serializeSchedule)
		.filter((schedule) => closureIds.has(schedule.workflow_id));
	return {
		workflow,
		candidate,
		sourceStates,
		schedules,
		publication: publicationConfig(platform!.env)
	};
};
