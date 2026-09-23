import { json } from '@sveltejs/kit';
import { parseStrictLibraryJson, LibraryValidationError } from '@tines/shared';
import { api, apiContext, ApiFail, requireJsonObject } from '$lib/server/api/core';
import { readLibraryEnvelope } from '$lib/server/library/transport';
import { prepareWorkflowPackage } from '$lib/server/library/plan';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/api/permissions';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	requireAccess(actor, [{ domain: 'control_plane', access: 'read' }], 'library.prepare');
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
		Object.keys(body).some((key) => !['document_json', 'choices'].includes(key)) ||
		typeof body.document_json !== 'string'
	)
		throw new ApiFail(422, 'invalid_field', 'Expected {document_json: string, choices?: object}');
	try {
		return json(
			await prepareWorkflowPackage(
				db,
				env,
				actor,
				body.document_json,
				body.choices === undefined ? {} : body.choices
			)
		);
	} catch (error) {
		if (error instanceof LibraryValidationError)
			throw new ApiFail(422, 'invalid_choices', error.message, { diagnostics: error.diagnostics });
		throw error;
	}
});
