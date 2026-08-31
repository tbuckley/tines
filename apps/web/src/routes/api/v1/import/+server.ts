import { json } from '@sveltejs/kit';
import { LIBRARY_MAX_BYTES, type ImportLibraryRequest } from '@tines/shared';
import { ApiFail, api, apiContext } from '$lib/server/api/core';
import { applyImport } from '$lib/server/api/library';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	// Size gate before parsing: `readJson` has no cap, and a library document
	// carries every prompt and skill file in full.
	const raw = await event.request.text();
	if (raw.length > LIBRARY_MAX_BYTES) {
		throw new ApiFail(
			422,
			'document_too_large',
			`This document is ${raw.length} bytes; at most ${LIBRARY_MAX_BYTES} can be imported at once`,
			{ field: 'document', max_bytes: LIBRARY_MAX_BYTES }
		);
	}
	let body: ImportLibraryRequest;
	try {
		body = JSON.parse(raw) as ImportLibraryRequest;
	} catch {
		throw new ApiFail(400, 'invalid_json', 'Request body must be valid JSON');
	}
	const result = await applyImport(db, env, actor, body);
	return json(result);
});
