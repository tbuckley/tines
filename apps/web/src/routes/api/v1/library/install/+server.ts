import { json } from '@sveltejs/kit';
import { parseStrictLibraryJson, LibraryValidationError } from '@tines/shared';
import { api, apiContext, ApiFail, requireJsonObject } from '$lib/server/api/core';
import { installWorkflowPackage } from '$lib/server/library/install';
import { runE2ePublicationRaceMutation } from '$lib/server/publications/e2e-race';
import { readLibraryEnvelope } from '$lib/server/library/transport';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	// Kept here as well as in the service: alternate callers cannot bypass it,
	// and the public route remains an explicit authority boundary.
	if (actor.agentRunId)
		throw new ApiFail(403, 'run_key_forbidden', 'Run keys cannot install workflow packages');
	let body: Record<string, unknown>;
	try {
		body = requireJsonObject(parseStrictLibraryJson(await readLibraryEnvelope(event.request)));
	} catch (error) {
		if (error instanceof LibraryValidationError)
			throw new ApiFail(400, 'invalid_json', error.message);
		throw error;
	}
	if (
		Object.keys(body).some(
			(key) => !['document_json', 'plan_token', 'confirmation'].includes(key)
		) ||
		typeof body.document_json !== 'string' ||
		typeof body.plan_token !== 'string' ||
		typeof body.confirmation !== 'object' ||
		body.confirmation === null ||
		Array.isArray(body.confirmation) ||
		Object.keys(body.confirmation).some((key) => key !== 'plan_digest') ||
		typeof (body.confirmation as Record<string, unknown>).plan_digest !== 'string'
	)
		throw new ApiFail(
			422,
			'invalid_field',
			'Expected {document_json, plan_token, confirmation:{plan_digest}}'
		);
	return json(
		await installWorkflowPackage(db, env, actor, body as never, (source) =>
			source
				? runE2ePublicationRaceMutation(event.request, env, { snapshotId: source.snapshot_id })
				: Promise.resolve()
		)
	);
});
