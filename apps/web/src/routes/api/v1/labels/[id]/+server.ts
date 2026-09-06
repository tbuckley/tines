import { json } from '@sveltejs/kit';
import type { DeleteLabelRequest, UpdateLabelRequest } from '@tines/shared';
import { api, apiContext, readJson, readOptionalJson } from '$lib/server/api/core';
import { deleteLabel, updateLabel } from '$lib/server/api/labels';
import { queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdateLabelRequest>(event);
	return json(await updateLabel(db, env, actor, event.params.id, body));
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readOptionalJson<DeleteLabelRequest>(event);
	const result = await deleteLabel(db, env, actor, event.params.id, { force: body.force === true });
	// A forced delete takes the label's routing rules with it, which changes
	// what matches — the same reason rule deletion queues a pass.
	if (result.routing_rules_deleted.length > 0) queueDispatchPass(event.platform, actor.userId);
	return json(result);
});
