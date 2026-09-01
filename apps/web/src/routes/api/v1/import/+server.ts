import { json } from '@sveltejs/kit';
import { LIBRARY_MAX_BYTES, type ImportLibraryRequest } from '@tines/shared';
import { ApiFail, api, apiContext, requireJsonObject } from '$lib/server/api/core';
import { applyImport } from '$lib/server/api/library';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	// Size gate before parsing: `readJson` has no cap, and a library document
	// carries every prompt and skill file in full.
	const raw = await event.request.text();
	// Measured in bytes, not UTF-16 units: non-ASCII prompt bodies are up to
	// three times longer on the wire than `raw.length` suggests.
	const bytes = new TextEncoder().encode(raw).length;
	if (bytes > LIBRARY_MAX_BYTES) {
		throw new ApiFail(
			422,
			'document_too_large',
			`This document is ${bytes} bytes; at most ${LIBRARY_MAX_BYTES} can be imported at once`,
			{ field: 'document', max_bytes: LIBRARY_MAX_BYTES }
		);
	}
	let body: ImportLibraryRequest;
	try {
		// Hand-parsed so the size gate runs first, but held to the same
		// "must be a JSON object" contract as every other endpoint.
		body = requireJsonObject(JSON.parse(raw)) as unknown as ImportLibraryRequest;
	} catch (e) {
		if (e instanceof ApiFail) throw e;
		throw new ApiFail(400, 'invalid_json', 'Request body must be valid JSON');
	}
	const result = await applyImport(db, env, actor, body);
	return json(result);
});
