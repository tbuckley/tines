import { json } from '@sveltejs/kit';
import type { UpdateSupervisorSettingsRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { getSupervisorSettings, updateSupervisorSettings } from '$lib/server/api/supervisor';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getSupervisorSettings(db, actor.userId));
});

export const PUT: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdateSupervisorSettingsRequest>(event);
	return json(await updateSupervisorSettings(db, env, actor, body));
});
