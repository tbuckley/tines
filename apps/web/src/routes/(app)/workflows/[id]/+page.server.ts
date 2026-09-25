import { error } from '@sveltejs/kit';
import { truncate } from '$lib/format';
import { listContextItemsForStates } from '$lib/server/api/context';
import { countOpenIssuesByWorkflow } from '$lib/server/api/issues';
import { resolveFocus } from '$lib/server/api/preferences';
import { ApiFail, sessionActor } from '$lib/server/api/core';
import { listRoutingRules } from '$lib/server/api/routing';
import { readSharedWorkflow } from '$lib/server/api/shared-workflows';
import { loadWorkflow, loadWorkflows } from '$lib/server/api/workflows';
import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params, depends }) => {
	depends('app:preferences');
	const db = getDb(platform!.env);
	const userId = locals.user!.id;
	const notFound = (e: unknown): never => {
		const status = e instanceof ApiFail ? e.status : 500;
		error(
			status,
			status === 404 ? `No workflow has the ID “${truncate(params.id)}”.` : 'Not found'
		);
	};
	const owned = await loadWorkflow(db, userId, params.id).catch((e) => {
		if (e instanceof ApiFail && e.status === 404) return null;
		return notFound(e);
	});
	if (!owned) {
		// A member of a shared project reads the owner's workflow, but its
		// editing, context and routing stay the owner's.
		const workflow = await readSharedWorkflow(db, sessionActor(locals.user!), params.id).catch(
			notFound
		);
		const owner = await db
			.selectFrom('workflow')
			.innerJoin('user', 'user.id', 'workflow.user_id')
			.select('user.name')
			.where('workflow.id', '=', workflow.id)
			.executeTakeFirst();
		return {
			workflow,
			sharedOwnerName: owner?.name ?? 'the project owner',
			routingRules: [],
			contextItems: [],
			workflows: [],
			focusId: null,
			focusedOpenCount: null
		};
	}
	const workflow = owned;
	const [contextItems, workflows, routingRules, { focusId }] = await Promise.all([
		listContextItemsForStates(
			db,
			userId,
			workflow.states.map((s) => s.id)
		),
		loadWorkflows(db, userId),
		listRoutingRules(db, userId),
		resolveFocus(db, userId)
	]);
	const stateIds = new Set(workflow.states.map((s) => s.id));
	return {
		workflow,
		sharedOwnerName: null,
		// The inline agent-routing rows: rules scoped to this workflow's states.
		routingRules: routingRules.filter(
			(r) => r.scope.workflow_state_id !== null && stateIds.has(r.scope.workflow_state_id)
		),
		// Issue-anchored items stay on their issue's page.
		contextItems: contextItems.filter((i) => i.scope.issue_id === null),
		// `projects` comes from the app layout.
		workflows,
		focusId,
		focusedOpenCount: focusId
			? ((await countOpenIssuesByWorkflow(db, userId, focusId))[workflow.id] ?? 0)
			: null
	};
};
