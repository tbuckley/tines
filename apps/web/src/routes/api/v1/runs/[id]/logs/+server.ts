import { json } from '@sveltejs/kit';
import type { AppendRunLogRequest } from '@tines/shared';
import { api, readJson } from '$lib/server/api/core';
import { appendRunLog, runnerProtocolContext } from '$lib/server/api/runner-protocol';
import type { RequestHandler } from './$types';

/**
 * Log-chunk append from the daemon (runner-token auth; the run must belong
 * to that runner). The first append flips the run `launching → running`.
 */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, runner } = await runnerProtocolContext(event);
	const body = await readJson<AppendRunLogRequest>(event);
	return json(await appendRunLog(db, env, runner, event.params.id, body.chunk));
});
