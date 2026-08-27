import { listProjects } from '$lib/server/api/projects';
import { listRoutingRules } from '$lib/server/api/routing';
import { listRunners } from '$lib/server/api/runners';
import { listRuns } from '$lib/server/api/runs';
import { getSupervisorSettings } from '$lib/server/api/supervisor';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const [runners, rules, settings, projects, workflows, runs] = await Promise.all([
		listRunners(db, userId),
		listRoutingRules(db, userId),
		getSupervisorSettings(db, userId),
		listProjects(db, userId),
		loadWorkflows(db, userId),
		listRuns(db, userId, {}, { cursor: null, limit: 50 })
	]);
	return { runners, rules, settings, projects, workflows, runs: runs.items };
};
