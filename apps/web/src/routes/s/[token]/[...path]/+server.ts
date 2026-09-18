import { artifactSiteResponse } from '$lib/server/api/artifacts';
import { getDb } from '$lib/server/db';
import { siteErrorPage } from '$lib/server/artifact-site';
import type { RequestHandler } from './$types';

/**
 * The relative-URL contract needs the trailing slash of `/s/<token>/` to
 * survive, so Kit must not normalize it away.
 */
export const trailingSlash = 'ignore';

/**
 * Serves an artifact site (specs/artifacts/SPEC.md "Sites"). No session and
 * no `apiContext`: the signed token in the path is the whole authorization,
 * and every failure is a small HTML page, because a human opens this URL in
 * a tab.
 */
export const GET: RequestHandler = async (event) => {
	if (!event.platform) return siteErrorPage(404);
	// `/s/<token>` (no slash) would resolve relative URLs against `/s/`.
	if (!event.url.pathname.startsWith(`/s/${event.params.token}/`)) {
		return new Response(null, {
			status: 302,
			headers: { location: `/s/${event.params.token}/`, 'cache-control': 'no-store' }
		});
	}
	return artifactSiteResponse(
		getDb(event.platform.env),
		event.platform.env,
		event.url,
		event.params.token,
		event.params.path ?? ''
	);
};
