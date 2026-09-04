import { countIssuesByCategory, listIssues } from '$lib/server/api/issues';
import { listProjects } from '$lib/server/api/projects';
import { listLabels } from '$lib/server/api/labels';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;

	const filters = {
		project: url.searchParams.get('project') ?? undefined,
		state: url.searchParams.get('state') ?? undefined,
		category: url.searchParams.get('category') ?? undefined,
		showDone: url.searchParams.get('done') === '1',
		ready: url.searchParams.get('ready') === '1',
		q: url.searchParams.get('q') ?? undefined,
		// Repeatable: ?label=a&label=b narrows to issues carrying both.
		labels: url.searchParams.getAll('label')
	};

	// Everything but the category tab itself; the tabs' counts share it.
	const scope = {
		project: filters.project,
		state: filters.state,
		ready: filters.ready,
		q: filters.q,
		labels: filters.labels
	};

	const [{ items: issues }, counts, projects, workflows, labels] = await Promise.all([
		listIssues(
			db,
			userId,
			{
				...scope,
				category: filters.category,
				// Ready already implies not-done, so the "show done" state is
				// simply parked in the URL while it is on.
				hideDone: !filters.showDone && !filters.category && !filters.state
			},
			{ cursor: null, limit: 100 }
		),
		countIssuesByCategory(db, userId, scope),
		listProjects(db, userId),
		loadWorkflows(db, userId),
		listLabels(db, userId)
	]);

	return { issues, counts, projects, workflows, labels, filters };
};
