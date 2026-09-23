import { json } from '@sveltejs/kit';
import type { DeleteAnchorRequest, UpdateWorkflowRequest } from '@tines/shared';
import { api, apiContext, readJson, readOptionalJson } from '$lib/server/api/core';
import { deleteWorkflow, loadWorkflow, updateWorkflow } from '$lib/server/api/workflows';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await loadWorkflow(db, actor.userId, event.params.id));
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const body = await readJson<UpdateWorkflowRequest>(event);
	return json(await updateWorkflow(db, env, actor, effects, event.params.id, body));
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readOptionalJson<DeleteAnchorRequest>(event);
	const { deleted_context } = await deleteWorkflow(db, env, actor, event.params.id, {
		forceDeleteContext: body.force_delete_context === true,
		forceClearInheritance: body.force_clear_inheritance === true
	});
	if (deleted_context.length > 0) {
		return json({
			deleted_context
		});
	}
	return new Response(null, { status: 204 });
});
