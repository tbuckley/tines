import { json } from '@sveltejs/kit';
import { parseStrictLibraryJson, LibraryValidationError } from '@tines/shared';
import { api, apiContext, ApiFail, requireJsonObject } from '$lib/server/api/core';
import { readLibraryEnvelope } from '$lib/server/library/transport';
import { validatePortableLibrary } from '$lib/server/api/library-packages';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	await apiContext(event);
	const raw = await readLibraryEnvelope(event.request);
	let body;
	try {
		body = requireJsonObject(parseStrictLibraryJson(raw));
	} catch (error) {
		if (error instanceof LibraryValidationError)
			throw new ApiFail(400, 'invalid_json', error.message);
		throw error;
	}
	if (
		Object.keys(body).some((key) => key !== 'document_json') ||
		typeof body.document_json !== 'string'
	)
		throw new ApiFail(422, 'invalid_field', 'Expected {document_json: string}');
	return json(await validatePortableLibrary(body.document_json));
});
