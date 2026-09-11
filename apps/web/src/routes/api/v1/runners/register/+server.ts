import { json } from '@sveltejs/kit';
import type { RegisterRunnerRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { registerRunner } from '$lib/server/api/runners';
import type { RequestHandler } from './$types';

/**
 * The daemon's registration/reconnect (user API key auth; run keys are
 * fenced off `/runners*` by the control-plane 403). The response's
 * `runner_token` is shown exactly once — only its hash is stored.
 */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const body = await readJson<RegisterRunnerRequest>(event);
	const runner = await registerRunner(db, env, actor, effects, body);
	return json(runner, { status: 201 });
});
