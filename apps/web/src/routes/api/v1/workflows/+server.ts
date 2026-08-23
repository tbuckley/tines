import { json } from '@sveltejs/kit';
import type { CreateWorkflowRequest, ListResponse, WorkflowResponse } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { createWorkflow, loadWorkflows } from '$lib/server/api/workflows';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const items = await loadWorkflows(db, actor.userId);
	const body: ListResponse<WorkflowResponse> = { items, next_cursor: null };
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<CreateWorkflowRequest>(event);
	const workflow = await createWorkflow(db, env, actor, body);
	return json(workflow, { status: 201 });
});
