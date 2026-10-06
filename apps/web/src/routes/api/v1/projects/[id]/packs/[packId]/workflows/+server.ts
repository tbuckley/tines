import { json } from '@sveltejs/kit';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { addPackWorkflow } from '$lib/server/api/packs/authoring';
import type { AddPackWorkflowRequest } from '@tines/shared';
import type { RequestHandler } from './$types';

/** Copies a workflow used in this project into the (authored) pack. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<AddPackWorkflowRequest>(event);
	return json(await addPackWorkflow(db, env, actor, event.params.id, event.params.packId, body), {
		status: 201
	});
});
