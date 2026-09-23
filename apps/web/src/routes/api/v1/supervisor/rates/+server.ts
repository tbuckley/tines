import { json } from '@sveltejs/kit';
import type { CreateUserModelRateRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { createRate, listRates } from '$lib/server/api/rates';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await listRates(db, actor.userId));
});

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<CreateUserModelRateRequest>(event);
	return json(await createRate(db, env, actor.userId, body), { status: 201 });
});
