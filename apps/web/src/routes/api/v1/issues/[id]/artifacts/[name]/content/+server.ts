import { artifactContentResponse } from '$lib/server/api/artifacts';
import { api, apiContext, ApiFail } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

/** Bytes of a version (default: current). See "Serving content safely". */
export const GET: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const rawVersion = event.url.searchParams.get('version');
	let version: number | undefined;
	if (rawVersion !== null) {
		version = Number.parseInt(rawVersion, 10);
		if (!Number.isFinite(version) || version < 1) {
			throw new ApiFail(422, 'invalid_field', '"version" must be a positive integer', { field: 'version' });
		}
	}
	return artifactContentResponse(db, env, actor.userId, event.params.id, event.params.name, {
		version,
		inline: ['1', 'true'].includes(event.url.searchParams.get('inline') ?? '')
	});
});
