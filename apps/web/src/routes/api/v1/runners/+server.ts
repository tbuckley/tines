import { json } from '@sveltejs/kit';
import type { CreateRunnerRequest, ListResponse, Runner } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { createRunner, listRunners } from '$lib/server/api/runners';
import { queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	// The registry is small by nature (one row per device/integration).
	const body: ListResponse<Runner> = {
		items: await listRunners(db, actor.userId),
		next_cursor: null
	};
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<CreateRunnerRequest>(event);
	const runner = await createRunner(db, env, actor, body);
	// A new managed runner is capacity that came online (managed types are
	// always "online"), so eligible work can dispatch to it right away.
	queueDispatchPass(event.platform, actor.userId);
	return json(runner, { status: 201 });
});
