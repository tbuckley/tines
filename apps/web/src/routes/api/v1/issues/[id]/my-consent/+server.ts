import { json } from '@sveltejs/kit';
import type { IssueConsentRequest } from '@tines/shared';
import { ApiFail, api, apiContext, readJson } from '$lib/server/api/core';
import { readIssueConsent, writeIssueConsent } from '$lib/server/api/personal-consent';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	return json(await readIssueConsent(db, actor.userId, event.params.id));
});

export const PUT: RequestHandler = api(async (event) => {
	const origin = event.request.headers.get('origin');
	if (!origin || origin !== event.url.origin) {
		throw new ApiFail(
			403,
			'origin_required',
			'Personal permission changes require this browser origin'
		);
	}
	const { db, env, actor } = await apiContext(event);
	const body = await readJson<IssueConsentRequest>(event);
	return json(await writeIssueConsent(db, env, actor, event.params.id, body));
});
