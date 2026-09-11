import { json } from '@sveltejs/kit';
import type { UpdateRoutingRuleRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { deleteRoutingRule, updateRoutingRule } from '$lib/server/api/routing';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const body = await readJson<UpdateRoutingRuleRequest>(event);
	const rule = await updateRoutingRule(db, env, actor, effects, event.params.id, body);
	return json(rule);
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	await deleteRoutingRule(db, env, actor, effects, event.params.id);
	return new Response(null, { status: 204 });
});
