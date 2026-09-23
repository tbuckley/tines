import { json } from '@sveltejs/kit';
import type { DeleteRunnerRequest, UpdateRunnerRequest } from '@tines/shared';
import { api, apiContext, readJson, readOptionalJson } from '$lib/server/api/core';
import { deleteRunner, getRunner, updateRunner } from '$lib/server/api/runners';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getRunner(db, actor, event.params.id));
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const body = await readJson<UpdateRunnerRequest>(event);
	const runner = await updateRunner(db, env, actor, effects, event.params.id, body);
	return json(runner);
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const body = await readOptionalJson<DeleteRunnerRequest>(event);
	await deleteRunner(db, env, actor, effects, event.params.id, body.force === true);
	return new Response(null, { status: 204 });
});
