import { json } from '@sveltejs/kit';
import { parseStrictLibraryJson } from '@tines/shared';
import { api, apiContext, ApiFail, requireJsonObject } from '$lib/server/api/core';
import { readLibraryEnvelope } from '$lib/server/library/transport';
import { prepareStateRetirementRollback } from '$lib/server/state-retirement/service';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	try {
		const body = requireJsonObject(
			parseStrictLibraryJson(await readLibraryEnvelope(event.request, 64 * 1024))
		);
		if (typeof body.receipt_id !== 'string')
			throw new ApiFail(422, 'invalid_field', 'Expected receipt_id');
		return json(await prepareStateRetirementRollback(db, env, actor, body.receipt_id));
	} catch (error) {
		if (error instanceof ApiFail) throw error;
		throw new ApiFail(400, 'invalid_json', 'Request must be strict JSON');
	}
});
