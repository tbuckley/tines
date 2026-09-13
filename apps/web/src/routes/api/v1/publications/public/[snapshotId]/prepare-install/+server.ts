import { canonicalizeLibraryValue } from '@tines/shared';
import { json } from '@sveltejs/kit';
import { api, apiContext, ApiFail, readOptionalJson } from '$lib/server/api/core';
import { prepareWorkflowPackage } from '$lib/server/library/plan';
import {
	PUBLICATION_RESPONSE_HEADERS,
	PUBLICATION_UNAVAILABLE_MESSAGE,
	resolveHostedPublicSnapshot
} from '$lib/server/publications/public';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	if (actor.agentRunId)
		throw new ApiFail(403, 'run_key_forbidden', 'Run keys cannot install workflow packages');
	const body = await readOptionalJson<{ choices?: unknown }>(event);
	if (Object.keys(body).some((key) => key !== 'choices'))
		throw new ApiFail(422, 'invalid_field', 'Unknown hosted installation field');
	const hosted = await resolveHostedPublicSnapshot(db, event.params.snapshotId);
	if (!hosted) throw new ApiFail(404, 'publication_unavailable', PUBLICATION_UNAVAILABLE_MESSAGE);
	return json(
		await prepareWorkflowPackage(
			db,
			env,
			actor,
			canonicalizeLibraryValue(hosted.snapshot.document),
			body.choices ?? {},
			hosted.source
		),
		{ headers: PUBLICATION_RESPONSE_HEADERS }
	);
});
