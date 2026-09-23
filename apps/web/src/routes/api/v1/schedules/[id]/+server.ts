import { json } from '@sveltejs/kit';
import type { UpdateScheduleRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { deleteSchedule, getScheduleForActor, updateSchedule } from '$lib/server/api/schedules';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getScheduleForActor(db, actor, event.params.id));
});

export const PATCH: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdateScheduleRequest>(event);
	return json(await updateSchedule(db, env, actor, event.params.id, body));
});

export const DELETE: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	await deleteSchedule(db, env, actor, event.params.id);
	return new Response(null, { status: 204 });
});
