import { partitionProjects } from '$lib/archived';
import { listProjects } from '$lib/server/api/projects';
import { listRoutingRules } from '$lib/server/api/routing';
import { listRunners } from '$lib/server/api/runners';
import { listRuns } from '$lib/server/api/runs';
import { getSupervisorSettings, loadFleetQueue } from '$lib/server/api/supervisor';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const [runners, rules, settings, projects, workflows, runs, queue, repoItems] = await Promise.all(
		[
			listRunners(db, userId),
			listRoutingRules(db, userId),
			getSupervisorSettings(db, userId),
			listProjects(db, userId, { archived: 'all' }),
			loadWorkflows(db, userId),
			listRuns(db, userId, {}, { cursor: null, limit: 50 }),
			// The Now row (Tines/256): everything eligible with no run, grouped by
			// why it is waiting. Itself one parallel wave, so this adds no round trip.
			loadFleetQueue(db, userId),
			// The repos context items point at, for the PAT instructions: that set
			// is exactly what the token should be scoped to (and its blast radius).
			db
				.selectFrom('context_item')
				.select('repo_url')
				.distinct()
				.where('user_id', '=', userId)
				.where('kind', '=', 'repo')
				.where('repo_url', 'is not', null)
				.orderBy('repo_url')
				.execute()
		]
	);
	const { live, archived } = partitionProjects(projects);
	return {
		runners,
		rules,
		settings,
		projects: live,
		// Rules scoped to an archived project are kept and editable — the page
		// badges them, and the rule editor keeps the project selectable.
		archivedProjects: archived,
		workflows,
		runs: runs.items,
		queue,
		contextRepoUrls: repoItems.map((r) => r.repo_url).filter((u): u is string => u !== null)
	};
};
