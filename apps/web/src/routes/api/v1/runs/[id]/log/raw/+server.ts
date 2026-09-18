import { json } from '@sveltejs/kit';
import { api } from '$lib/server/api/core';
import { runnerProtocolContext, uploadRawRunLog } from '$lib/server/api/runner-protocol';
import type { RequestHandler } from './$types';

/**
 * `PUT /api/v1/runs/:id/log/raw` — the daemon's one-shot upload of the
 * unrendered harness stream (runner-token auth). The rendered log the user
 * reads is lossy by design; this keeps "every byte" literally true.
 *
 * Deliberately accepts an *ended* run: the daemon reports the run finished
 * before it settles the workspace, so this always arrives after the end.
 */
export const PUT: RequestHandler = api(async (event) => {
	const { db, env, runner } = await runnerProtocolContext(event);
	return json(await uploadRawRunLog(db, env, runner, event.params.id, event.request));
});
