import { json } from '@sveltejs/kit';
import type { AddIssueLabelsRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { addIssueLabels } from '$lib/server/api/labels';
import type { RequestHandler } from './$types';

/** Incremental add, never a set-replace: concurrent edits both survive. */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	const body = await readJson<AddIssueLabelsRequest>(event);
	const result = await addIssueLabels(db, env, actor, event.params.id, body.labels, effects);
	return json(result);
});
