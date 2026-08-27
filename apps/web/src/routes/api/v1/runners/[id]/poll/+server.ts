import { json } from '@sveltejs/kit';
import type { RunnerPollRequest } from '@tines/shared';
import { api, notFound, readJson } from '$lib/server/api/core';
import { pollRunner, runnerProtocolContext } from '$lib/server/api/runner-protocol';
import { queueDispatchPass } from '$lib/server/supervisor/engine';
import type { RequestHandler } from './$types';

/**
 * The daemon's poll: heartbeat, `owned_runs` reconciliation, one-shot
 * assignment delivery, and the `cancels` list. Runner-token auth only.
 */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, runner } = await runnerProtocolContext(event);
	// The token is the credential; the path must name the same runner.
	if (runner.id !== event.params.id) throw notFound();
	const body = await readJson<RunnerPollRequest>(event);
	const { response, cameOnline, capRaised } = await pollRunner(db, env, runner, body);
	// A poll bringing an offline runner back — or raising its cap — is
	// capacity coming online: queue the opportunistic pass so its next poll
	// finds work waiting.
	if (cameOnline || capRaised) queueDispatchPass({ env, ctx: event.platform?.ctx }, runner.user_id);
	return json(response);
});
