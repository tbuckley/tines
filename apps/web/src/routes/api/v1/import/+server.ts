import { json } from '@sveltejs/kit';
import {
	LIBRARY_MAX_BYTES,
	parseStrictLibraryJson,
	LibraryValidationError,
	type ImportLibraryRequest
} from '@tines/shared';
import { ApiFail, api, apiContext, requireJsonObject } from '$lib/server/api/core';
import { readLibraryEnvelope } from '$lib/server/library/transport';
import { applyImport } from '$lib/server/api/library';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/api/permissions';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor, effects } = await apiContext(event);
	requireAccess(
		actor,
		[
			{ domain: 'control_plane', access: 'write' },
			{ domain: 'project', access: 'write', scope: 'all' },
			{ domain: 'workspace', access: 'write' }
		],
		'library.import'
	);
	const raw = await readLibraryEnvelope(event.request);
	let body: ImportLibraryRequest;
	try {
		// Hand-parsed so the size gate runs first, but held to the same
		// "must be a JSON object" contract as every other endpoint.
		body = requireJsonObject(parseStrictLibraryJson(raw)) as unknown as ImportLibraryRequest;
	} catch (e) {
		if (e instanceof ApiFail) throw e;
		if (e instanceof LibraryValidationError)
			throw new ApiFail(400, 'invalid_json', e.message, { diagnostics: e.diagnostics });
		throw new ApiFail(400, 'invalid_json', 'Request body must be valid JSON');
	}
	if (new TextEncoder().encode(JSON.stringify(body.document)).byteLength > LIBRARY_MAX_BYTES)
		throw new ApiFail(422, 'document_too_large', `Document exceeds ${LIBRARY_MAX_BYTES} bytes`, {
			max_bytes: LIBRARY_MAX_BYTES
		});
	const result = await applyImport(db, env, actor, effects, body);
	return json(result);
});
