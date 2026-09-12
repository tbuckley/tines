import { json } from '@sveltejs/kit';
import type { FinishRunRequest } from '@tines/shared';
import { api, readJson } from '$lib/server/api/core';
import { finishRun, runnerProtocolContext } from '$lib/server/api/runner-protocol';
import type { RequestHandler } from './$types';

/**
 * The daemon's end report (runner-token auth; the run must belong to that
 * runner): endRun with the usual judgment and immediate key revocation.
 */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, runner, effects } = await runnerProtocolContext(event);
	const body = await readJson<FinishRunRequest>(event);
	const run = await finishRun(db, env, runner, effects, event.params.id, body);
	return json(run);
});
