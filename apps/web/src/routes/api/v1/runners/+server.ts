import { json } from '@sveltejs/kit';
import type { CreateRunnerRequest, ListResponse, Runner } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { createRunner, listRunners } from '$lib/server/api/runners';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	// The registry is small by nature (one row per device/integration).
	const body: ListResponse<Runner> = {
		items: await listRunners(db, actor),
		next_cursor: null
	};
	return json(body);
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const body = await readJson<CreateRunnerRequest>(event);
	const runner = await createRunner(db, env, actor, effects, body);
	return json(runner, { status: 201 });
});
