import { error } from '@sveltejs/kit';
import { truncate } from '$lib/format';
import { listContextItems } from '$lib/server/api/context';
import { ApiFail, sessionActor } from '$lib/server/api/core';
import { countIssuesByCategory, listIssues } from '$lib/server/api/issues';
import { listLabelsInternal } from '$lib/server/api/labels';
import { getProject } from '$lib/server/api/projects';
import { actorForProject, resolveProjectAccess } from '$lib/server/api/project-access';
import { readScheduleConsent } from '$lib/server/api/schedule-consent';
import { redactForMember, scopeBlockersForMember } from '$lib/server/api/member-context';
import { listRoutingRules } from '$lib/server/api/routing';
import { listSchedules } from '$lib/server/api/schedules';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import { issuePagination, readIssuePage } from '$lib/server/issue-pagination';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params, url }) => {
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const actor = {
		userId,
		userName: locals.user!.name,
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};
	const access = await resolveProjectAccess(db, actor, params.id).catch((e) => {
		if (e instanceof ApiFail && e.status === 404)
			error(404, `No project has the ID “${truncate(params.id)}”.`);
		if (e instanceof ApiFail) error(e.status, e.message);
		throw e;
	});
	// A member sees the owner's project page, loaded with the owner's scope.
	// Routing and account-wide context stay the owner's and are left out.
	const isMember = access.role === 'member';
	const scopeActor = isMember ? await actorForProject(db, actor, params.id) : actor;
	const ownerId = scopeActor.userId;
	let page;
	try {
		page = readIssuePage(url);
	} catch (e) {
		if (e instanceof ApiFail) error(e.status, e.message);
		throw e;
	}

	const project = await getProject(db, scopeActor, params.id).catch((e) => {
		const status = e instanceof ApiFail ? e.status : 500;
		error(status, status === 404 ? `No project has the ID “${truncate(params.id)}”.` : 'Not found');
	});
	// The same filters as the all-issues list, scoped to this project.
	const filters = {
		workflow: url.searchParams.get('workflow') ?? undefined,
		state: url.searchParams.get('state') ?? undefined,
		category: url.searchParams.get('category') ?? undefined,
		showDone: url.searchParams.get('done') === '1',
		showDuplicates: url.searchParams.get('duplicates') === '1',
		ready: url.searchParams.get('ready') === '1',
		q: url.searchParams.get('q') ?? undefined,
		labels: url.searchParams.getAll('label')
	};
	const scope = {
		projectId: project.id,
		workflow: filters.workflow,
		state: filters.state,
		hideDuplicates: !filters.showDuplicates,
		ready: filters.ready,
		q: filters.q,
		labels: filters.labels
	};
	const [
		{ items: issues, hasMore },
		counts,
		labels,
		workflows,
		{ items: schedules },
		{ items: contextItems },
		routingRules
	] = await Promise.all([
		listIssues(
			db,
			ownerId,
			{
				...scope,
				category: filters.category,
				// Ready already implies not-done; "show done" just parks while it is on.
				hideDone: !filters.showDone && !filters.category && !filters.state,
				brief: true
			},
			page
		),
		countIssuesByCategory(db, ownerId, scope),
		listLabelsInternal(db, ownerId),
		loadWorkflows(db, ownerId),
		listSchedules(db, ownerId, { projectId: project.id }, { cursor: null, limit: 100 }),
		listContextItems(db, scopeActor, { project: project.id }, { cursor: null, limit: 100 }),
		isMember ? Promise.resolve([]) : listRoutingRules(db, ownerId)
	]);
	// The inline agent-routing rows: this project's own rules, or — when it
	// has none — the global rule its issues would fall back to.
	const projectRules = routingRules.filter((r) => r.scope.project_id === project.id);
	const fallbackRules = routingRules.filter(
		(r) => r.scope.project_id === null && r.scope.workflow_state_id === null
	);
	// A member's schedule switches are their own future permission.
	const viewerSchedules = isMember
		? await Promise.all(
				schedules.map(async (schedule) => ({
					...schedule,
					my_future_permission: (await readScheduleConsent(db, userId, schedule.id))
						.my_future_permission
				}))
			)
		: schedules;
	return {
		viewerRole: access.role,
		owner: isMember ? { id: ownerId, name: scopeActor.userName } : null,
		routingRules: projectRules.length > 0 ? projectRules : fallbackRules,
		project: { ...project, viewer_role: access.role },
		issues: scopeBlockersForMember(scopeActor, issues),
		workflows,
		schedules: viewerSchedules,
		// Issue-anchored items appear only on their issue's page (and the
		// Context tab) — they are that issue's business. A member sees this
		// project's own items only, never the owner's global ones.
		contextItems: contextItems
			.filter((i) => i.scope.issue_id === null)
			.filter((i) => !isMember || i.scope.project_id === project.id)
			.map((i) => redactForMember(scopeActor, i)),
		counts,
		labels,
		filters,
		pagination: issuePagination(url, page, issues, hasMore)
	};
};
