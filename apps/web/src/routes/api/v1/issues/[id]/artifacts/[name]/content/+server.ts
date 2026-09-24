import { artifactContentResponseForActor } from '$lib/server/api/artifacts';
import { actorForIssue } from '$lib/server/api/project-access';
import { api, apiContext, ApiFail } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

/** Bytes of a version (default: current). See "Serving content safely". */
export const GET: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	const rawVersion = event.url.searchParams.get('version');
	let version: number | undefined;
	if (rawVersion !== null) {
		version = Number.parseInt(rawVersion, 10);
		if (!Number.isFinite(version) || version < 1) {
			throw new ApiFail(422, 'invalid_field', '"version" must be a positive integer', {
				field: 'version'
			});
		}
	}
	const options = {
		version,
		inline: ['1', 'true'].includes(event.url.searchParams.get('inline') ?? ''),
		path: event.url.searchParams.get('path') ?? undefined
	};
	return artifactContentResponseForActor(
		db,
		env,
		actor,
		event.params.id,
		event.params.name,
		options
	);
});
