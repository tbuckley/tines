import { json } from '@sveltejs/kit';
import type { CreateRoutingRuleRequest, ListResponse, RoutingRule } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { createRoutingRule, listRoutingRules } from '$lib/server/api/routing';
import { queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	// At most one rule per scope keeps this list small; no pagination needed.
	const body: ListResponse<RoutingRule> = {
		items: await listRoutingRules(db, actor.userId),
		next_cursor: null
	};
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<CreateRoutingRuleRequest>(event);
	const rule = await createRoutingRule(db, env, actor, body);
	// A new rule can route previously unrouted (waiting) issues.
	queueDispatchPass(event.platform, actor.userId);
	return json(rule, { status: 201 });
});
