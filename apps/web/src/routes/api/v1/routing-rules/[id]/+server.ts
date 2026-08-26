import { json } from '@sveltejs/kit';
import type { UpdateRoutingRuleRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { deleteRoutingRule, updateRoutingRule } from '$lib/server/api/routing';
import { queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdateRoutingRuleRequest>(event);
	const rule = await updateRoutingRule(db, env, actor, event.params.id, body);
	// A retargeted rule can route waiting issues to available capacity.
	queueDispatchPass(event.platform, actor.userId);
	return json(rule);
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	await deleteRoutingRule(db, env, actor, event.params.id);
	return new Response(null, { status: 204 });
});
