import { error } from '@sveltejs/kit';
import { truncate } from '$lib/format';
import { listContextItems } from '$lib/server/api/context';
import { ApiFail } from '$lib/server/api/core';
import { countIssuesByCategory, listIssues } from '$lib/server/api/issues';
import { listLabels } from '$lib/server/api/labels';
import { getProject } from '$lib/server/api/projects';
import { listRoutingRules } from '$lib/server/api/routing';
import { listSchedules } from '$lib/server/api/schedules';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;

	const project = await getProject(db, userId, params.id).catch((e) => {
		const status = e instanceof ApiFail ? e.status : 500;
		error(status, status === 404 ? `No project has the ID “${truncate(params.id)}”.` : 'Not found');
	});
	// The same filters as the all-issues list, scoped to this project.
	const filters = {
		state: url.searchParams.get('state') ?? undefined,
		category: url.searchParams.get('category') ?? undefined,
		showDone: url.searchParams.get('done') === '1',
		ready: url.searchParams.get('ready') === '1',
		q: url.searchParams.get('q') ?? undefined,
		labels: url.searchParams.getAll('label')
	};
	const scope = {
		projectId: project.id,
		state: filters.state,
		ready: filters.ready,
		q: filters.q,
		labels: filters.labels
	};
	const [
		{ items: issues },
		counts,
		labels,
		workflows,
		{ items: schedules },
		{ items: contextItems },
		routingRules
	] = await Promise.all([
		listIssues(
			db,
			userId,
			{
				...scope,
				category: filters.category,
				// Ready already implies not-done; "show done" just parks while it is on.
				hideDone: !filters.showDone && !filters.category && !filters.state
			},
			{ cursor: null, limit: 100 }
		),
		countIssuesByCategory(db, userId, scope),
		listLabels(db, userId),
		loadWorkflows(db, userId),
		listSchedules(db, userId, { projectId: project.id }, { cursor: null, limit: 100 }),
		listContextItems(db, userId, { project: project.id }, { cursor: null, limit: 100 }),
		listRoutingRules(db, userId)
	]);
	// The inline agent-routing rows: this project's own rules, or — when it
	// has none — the global rule its issues would fall back to.
	const projectRules = routingRules.filter((r) => r.scope.project_id === project.id);
	const fallbackRules = routingRules.filter(
		(r) => r.scope.project_id === null && r.scope.workflow_state_id === null
	);
	return {
		routingRules: projectRules.length > 0 ? projectRules : fallbackRules,
		project,
		issues,
		workflows,
		schedules,
		// Issue-anchored items appear only on their issue's page (and the
		// Context tab) — they are that issue's business.
		contextItems: contextItems.filter((i) => i.scope.issue_id === null),
		counts,
		labels,
		filters
	};
};
