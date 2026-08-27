import { json } from '@sveltejs/kit';
import type { UpdateSupervisorSettingsRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { getSupervisorSettings, updateSupervisorSettings } from '$lib/server/api/supervisor';
import { queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await getSupervisorSettings(db, actor.userId));
});

export const PUT: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<UpdateSupervisorSettingsRequest>(event);
	const settings = await updateSupervisorSettings(db, env, actor, body);
	// Settings writes can unblock dispatch: the kill switch flipping on, a
	// quota-policy change raising a limit.
	queueDispatchPass(event.platform, actor.userId);
	return json(settings);
});
