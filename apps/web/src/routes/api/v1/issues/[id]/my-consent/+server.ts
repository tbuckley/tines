import { json } from '@sveltejs/kit';
import type { IssueConsentRequest } from '@tines/shared';
import { ApiFail, api, apiContext, readJson, runKeyForbidden } from '$lib/server/api/core';
import { readIssueConsent, writeIssueConsent } from '$lib/server/api/personal-consent';
import type { RequestHandler } from './$types';
import { sql } from 'kysely';
import { resolveIssueAccess } from '$lib/server/api/project-access';

export const GET: RequestHandler = api(async (event) => {
	const { db, actor } = await apiContext(event);
	if (actor.agentRunId) throw runKeyForbidden({ operation: 'issue.consent.read' });
	await resolveIssueAccess(db, actor, event.params.id);
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
	const beforeCommit =
		import.meta.env.VITE_TINES_E2E === '1' &&
		event.request.headers.get('x-tines-e2e-member-race') === 'revoke-before-choice'
			? async () => {
					await sql`UPDATE project_member SET revoked_at = ${Date.now()}, revision = revision + 1
				WHERE project_id = (SELECT project_id FROM issue WHERE id = ${event.params.id})
				AND user_id = ${actor.userId} AND revoked_at IS NULL`.execute(db);
				}
			: undefined;
	return json(await writeIssueConsent(db, env, actor, event.params.id, body, beforeCommit));
});
