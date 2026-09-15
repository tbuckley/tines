import { json } from '@sveltejs/kit';
import {
	LibraryValidationError,
	parseStrictLibraryJson,
	type PreparePublicationRequest
} from '@tines/shared';
import { api, apiContext, ApiFail, requireJsonObject } from '$lib/server/api/core';
import { readLibraryEnvelope } from '$lib/server/library/transport';
import { preparePublication } from '$lib/server/publications/prepare';
import type { RequestHandler } from './$types';

const exactKeys = (value: Record<string, unknown>, allowed: string[]) =>
	Object.keys(value).every((key) => allowed.includes(key));

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	let body: Record<string, unknown>;
	try {
		body = requireJsonObject(parseStrictLibraryJson(await readLibraryEnvelope(event.request)));
	} catch (error) {
		if (error instanceof LibraryValidationError)
			throw new ApiFail(400, 'invalid_json', error.message);
		throw error;
	}
	if (!exactKeys(body, ['prepare_request_id', 'source', 'metadata']))
		throw new ApiFail(422, 'invalid_field', 'Unknown publication preparation field');
	const source = requireJsonObject(body.source);
	const metadata = requireJsonObject(body.metadata);
	if (
		!exactKeys(metadata, ['display_name', 'license', 'license_year']) ||
		typeof source.kind !== 'string' ||
		(source.kind === 'owned_workflow' &&
			(!exactKeys(source, ['kind', 'workflow_id', 'options']) ||
				typeof source.workflow_id !== 'string' ||
				!source.options ||
				typeof source.options !== 'object' ||
				Array.isArray(source.options))) ||
		(source.kind === 'file' &&
			(!exactKeys(source, ['kind', 'document_json']) ||
				typeof source.document_json !== 'string')) ||
		!['owned_workflow', 'file'].includes(source.kind)
	)
		throw new ApiFail(422, 'invalid_publication_source', 'Invalid publication source');
	return json(
		await preparePublication(db, env, actor, {
			prepare_request_id: body.prepare_request_id,
			source,
			metadata
		} as unknown as PreparePublicationRequest)
	);
});
