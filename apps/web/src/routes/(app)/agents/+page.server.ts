import { listRoutingRules } from '$lib/server/api/routing';
import { listRunners } from '$lib/server/api/runners';
import { listRuns } from '$lib/server/api/runs';
import { getSupervisorSettings, loadFleetQueue } from '$lib/server/api/supervisor';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, parent }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const [runners, rules, settings, workflows, runs, queue, repoItems, newestIssue, layoutData] =
		await Promise.all([
		listRunners(db, userId),
		listRoutingRules(db, userId),
		getSupervisorSettings(db, userId),
		loadWorkflows(db, userId),
		listRuns(db, userId, {}, { cursor: null, limit: 50 }),
		// The Now row (Tines/256): everything eligible with no run, grouped by
		// why it is waiting. Itself one parallel wave, so this adds no round trip.
		loadFleetQueue(db, userId),
		// The repos context items point at, for the PAT instructions: that set
		// is exactly what the token should be scoped to (and its blast radius).
		db
			.selectFrom('context_item')
			.select(['repo_url', 'project_id'])
			.distinct()
			.where('user_id', '=', userId)
			.where('kind', '=', 'repo')
			.where('repo_url', 'is not', null)
			.orderBy('repo_url')
			.execute(),
			// The newest issue on the account: the first-run checklist names it
			// as the one to give a description. `issue` has no user_id, so the
			// project join is what scopes it.
			db
				.selectFrom('issue')
				.innerJoin('project', 'project.id', 'issue.project_id')
				.select([
					'project.name as project_name',
					'project.id as project_id',
					'issue.number',
					'issue.title',
					'issue.description'
				])
				.where('project.user_id', '=', userId)
				.orderBy('issue.created_at', 'desc')
				.orderBy('issue.id', 'desc')
				.limit(1)
				.executeTakeFirst(),
			parent()
		]);
	// Counted before the partition, so an archived project's issues still count:
	// the item asks whether the account has an issue at all.
	const hasAnyIssue = [...layoutData.projects, ...layoutData.archivedProjects].some(
		(p) => p.issue_count > 0
	);
	return {
		hasAnyIssue,
		hasAnyRun: runs.items.length > 0,
		newestIssue: newestIssue
			? {
					project_name: newestIssue.project_name,
					number: newestIssue.number,
					title: newestIssue.title,
					has_description: newestIssue.description.trim() !== '',
					has_repo: repoItems.some(
						(r) => r.project_id === null || r.project_id === newestIssue.project_id
					)
				}
			: null,
		runners,
		rules,
		settings,
		workflows,
		runs: runs.items,
		queue,
		contextRepoUrls: repoItems.map((r) => r.repo_url).filter((u): u is string => u !== null)
	};
};
