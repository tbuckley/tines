import { error } from '@sveltejs/kit';
import { truncate } from '$lib/format';
import { listContextItems, listContextItemsForStates } from '$lib/server/api/context';
import { ApiFail, sessionActor } from '$lib/server/api/core';
import { countIssuesByCategory, listIssues } from '$lib/server/api/issues';
import { listLabelsInternal } from '$lib/server/api/labels';
import { listInclusionCandidates, listInclusions } from '$lib/server/api/guidance-inclusions';
import { getProject } from '$lib/server/api/projects';
import { actorForProject, resolveProjectAccess } from '$lib/server/api/project-access';
import { readScheduleConsent } from '$lib/server/api/schedule-consent';
import { redactForMember, scopeBlockersForMember } from '$lib/server/api/member-context';
import { listRoutingRules } from '$lib/server/api/routing';
import { listSchedules } from '$lib/server/api/schedules';
import { isSharedProject, sharedExecutionEnabled } from '$lib/server/api/shared-execution';
import { loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import { issuePagination, readIssuePage } from '$lib/server/issue-pagination';
import type { Kysely } from 'kysely';
import type { ContextItem, Workflow } from '@tines/shared';
import type { Database } from '$lib/server/db';
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
	const sharedGuidance =
		!isMember &&
		sharedExecutionEnabled(platform!.env) &&
		isSharedProject({ shared_at: project.shared_at ?? null })
			? await loadSharedGuidance(db, platform!.env, actor, project.id, contextItems, workflows)
			: null;
	return {
		viewerRole: access.role,
		sharedGuidance,
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

/** Guidance kinds a shared project carries; env and artifact never travel. */
const isGuidance = (item: ContextItem) => item.kind !== 'env' && item.kind !== 'artifact';

/**
 * The owner's "Shared guidance" block (Tines/752): what is included from the
 * library, what could be, and a review of everything the project shares —
 * its own items, and the workflow-stage guidance of every workflow its
 * unfinished issues are in.
 */
async function loadSharedGuidance(
	db: Kysely<Database>,
	env: Env,
	actor: Parameters<typeof listInclusions>[2],
	projectId: string,
	projectItems: ContextItem[],
	workflows: Workflow[]
) {
	const [{ items: included }, candidates, active] = await Promise.all([
		listInclusions(db, env, actor, projectId),
		listInclusionCandidates(db, env, actor, projectId),
		db
			.selectFrom('issue')
			.innerJoin('workflow_state as s', 's.id', 'issue.state_id')
			.select('issue.workflow_id')
			.distinct()
			.where('issue.project_id', '=', projectId)
			.where('s.category', '!=', 'done')
			.execute()
	]);
	const activeWorkflows = workflows.filter((w) => active.some((a) => a.workflow_id === w.id));
	// A state carries its inherited base states' guidance too (Tines/238).
	const allStates = new Map(workflows.flatMap((w) => w.states).map((s) => [s.id, s]));
	const chains = new Map(
		activeWorkflows.map((workflow) => {
			const names = new Map<string, string>();
			for (const state of workflow.states) {
				for (
					let id: string | null = state.id;
					id !== null && !names.has(id);
					id = allStates.get(id)?.inherits_from ?? null
				)
					names.set(id, allStates.get(id)?.name ?? state.name);
			}
			return [workflow.id, names];
		})
	);
	const stateItems = await listContextItemsForStates(db, actor.userId, [
		...new Set([...chains.values()].flatMap((names) => [...names.keys()]))
	]);
	return {
		included,
		candidates,
		projectItemCount: projectItems.filter(isGuidance).length,
		workflows: activeWorkflows
			.map((workflow) => {
				const states = chains.get(workflow.id)!;
				return {
					id: workflow.id,
					name: workflow.name,
					items: stateItems
						.filter(isGuidance)
						.filter((i) => i.scope.issue_id === null)
						.filter((i) => i.scope.project_id === null || i.scope.project_id === projectId)
						.filter((i) => states.has(i.scope.workflow_state_id!))
						.map((i) => ({
							id: i.id,
							kind: i.kind,
							name: i.name,
							state: states.get(i.scope.workflow_state_id!)!
						}))
				};
			})
			.filter((group) => group.items.length > 0)
	};
}
