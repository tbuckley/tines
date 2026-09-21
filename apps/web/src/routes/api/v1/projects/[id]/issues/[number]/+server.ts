import { json } from '@sveltejs/kit';
import { api, apiContext, notFound } from '$lib/server/api/core';
import { getIssueDetailForActor } from '$lib/server/api/issues';
import type { RequestHandler } from './$types';

/** Lookup by human-facing ref: project id + per-project issue number. */
export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	const number = Number.parseInt(event.params.number, 10);
	if (!Number.isFinite(number)) throw notFound();
	return json(
		await getIssueDetailForActor(db, actor, { projectId: event.params.id, number }, { round: true })
	);
});
