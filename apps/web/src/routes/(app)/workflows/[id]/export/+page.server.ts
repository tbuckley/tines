import { error } from '@sveltejs/kit';
import { exportWorkflowPackage } from '$lib/server/library/export';
import { loadWorkflow } from '$lib/server/api/workflows';
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
	const candidate = await exportWorkflowPackage(db, userId, workflow.id);
	const sourceStates = [...workflow.states]
		.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
		.map((state, stateIndex) => ({
			id: state.id,
			local_id: candidate.workflows[0].states[stateIndex].id,
			name: state.name,
			workflow_name: workflow.name
		}));
	const schedules = (await scheduleQuery(db, userId).execute())
		.map(serializeSchedule)
		.filter((schedule) => schedule.workflow_id === workflow.id);
	return {
		workflow,
		candidate,
		sourceStates,
		schedules,
		publication: publicationConfig(platform!.env)
	};
};
