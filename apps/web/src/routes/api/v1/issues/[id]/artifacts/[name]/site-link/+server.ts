import { json } from '@sveltejs/kit';
import { createSiteLink } from '$lib/server/api/artifacts';
import { ApiFail, api, apiContext } from '$lib/server/api/core';
import { actorForIssue } from '$lib/server/api/project-access';
import type { RequestHandler } from './$types';

/**
 * Mints a short-lived signed URL that renders an HTML artifact live.
 * POST, not GET, so a capability URL is never prefetched or cached.
 */
export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor: requester } = await apiContext(event);
	// Members work on shared issues with the owner's scope (project-access.ts).
	const actor = await actorForIssue(db, requester, event.params.id);
	const body = (await readJson(event.request)) as { version?: unknown };
	return json(
		await createSiteLink(db, env, actor, event.params.id, event.params.name, {
			version: optionalVersion(body.version),
			requestOrigin: event.url.origin
		})
	);
});

function optionalVersion(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		throw new ApiFail(422, 'invalid_field', '"version" must be a positive integer', {
			field: 'version'
		});
	}
	return value;
}

/** The body is optional here (`{}` and no body both mean "current version"). */
async function readJson(request: Request): Promise<Record<string, unknown>> {
	try {
		const parsed = await request.json();
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
