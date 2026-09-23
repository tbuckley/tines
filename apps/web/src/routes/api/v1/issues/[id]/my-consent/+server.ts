import { json } from '@sveltejs/kit';
import type { IssueConsentRequest } from '@tines/shared';
import { api, apiContext, readJson } from '$lib/server/api/core';
import { readIssueConsent, writeIssueConsent } from '$lib/server/api/personal-consent';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await readIssueConsent(db, actor.userId, event.params.id));
});

export const PUT: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<IssueConsentRequest>(event);
	return json(await writeIssueConsent(db, env, actor, event.params.id, body));
});
