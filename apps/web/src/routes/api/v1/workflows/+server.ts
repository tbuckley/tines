import { json } from '@sveltejs/kit';
import type { CreateWorkflowRequest, ListResponse, WorkflowResponse } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { createWorkflow, loadWorkflowsForActor } from '$lib/server/api/workflows';
import { listSharedWorkflows } from '$lib/server/api/shared-workflows';
import { accessAllowed } from '$lib/server/api/permissions';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const [owned, shared] = await Promise.all([
		accessAllowed(actor, [{ domain: 'workspace', access: 'read' }], 'workflow.read')
			? loadWorkflowsForActor(db, actor)
			: Promise.resolve([]),
		listSharedWorkflows(db, actor)
	]);
	const ids = new Set(owned.map((item) => item.id));
	const items = [...owned, ...shared.filter((item) => !ids.has(item.id))];
	const body: ListResponse<WorkflowResponse> = { items, next_cursor: null };
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<CreateWorkflowRequest>(event);
	const workflow = await createWorkflow(db, env, actor, body);
	return json(workflow, { status: 201 });
});
