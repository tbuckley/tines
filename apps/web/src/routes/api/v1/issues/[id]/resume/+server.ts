import { api, apiContext, notFound } from '$lib/server/api/core';
import type { RequestHandler } from './$types';

/**
 * Resume (un-park) arrives with the dispatch engine. The route exists now
 * only so the control-plane fence holds on this path: run keys get their 403
 * from auth; everyone else gets a 404 until the endpoint is implemented.
 */
export const POST: RequestHandler = api(async (event) => {
	await apiContext(event);
	throw notFound();
});
