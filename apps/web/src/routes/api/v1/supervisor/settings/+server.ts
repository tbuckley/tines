import { json } from '@sveltejs/kit';
import type { UpdateSupervisorSettingsRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { getSupervisorSettings, updateSupervisorSettings } from '$lib/server/api/supervisor';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const settings = await getSupervisorSettings(db, actor.userId);
	// Run keys read the fleet's shape (Tines/256) but never the PAT's hint —
	// it is the token's first 8 and last 4 characters. Nulled here, not in the
	// service, so the page loader and the PUT response are unchanged.
	if (actor.agentRunId) return json({ ...settings, github_pat_hint: null });
	return json(settings);
});

export const PUT: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const body = await readJson<UpdateSupervisorSettingsRequest>(event);
	const settings = await updateSupervisorSettings(db, env, actor, body, effects);
	return json(settings);
});
