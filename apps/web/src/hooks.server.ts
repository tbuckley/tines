import { building } from '$app/environment';
import { getAuth } from '$lib/server/auth';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { svelteKitHandler } from 'better-auth/svelte-kit';

const FORM_CONTENT_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain'
]);

/**
 * CSRF guard replacing Kit's built-in checkOrigin (disabled in
 * vite.config.ts, where the rationale lives): the same
 * form-content-type-mutation origin check, scoped to requests that carry
 * cookies. A cookie-authenticated browser is the only surface a cross-site
 * form submission can ride — bearer-key clients set their own Authorization
 * header, which an attacker's page cannot forge cross-site without a
 * CORS preflight — and those clients (the CLI, agents) legitimately send
 * multipart artifact-folder uploads with no Origin header at all.
 */
function crossSiteFormSubmission(event: RequestEvent): boolean {
	const { request, url } = event;
	if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return false;
	const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (!FORM_CONTENT_TYPES.has(contentType)) return false;
	if (!request.headers.get('cookie')) return false;
	return request.headers.get('origin') !== url.origin;
}

export const handle: Handle = async ({ event, resolve }) => {
	if (building || !event.platform) {
		return resolve(event);
	}
	if (crossSiteFormSubmission(event)) {
		return new Response('Cross-site form submissions are forbidden', { status: 403 });
	}

	const auth = getAuth(event.platform.env, event.url.origin);
	event.locals.auth = auth;

	const sessionData = await auth.api.getSession({ headers: event.request.headers });
	event.locals.user = sessionData?.user ?? null;
	event.locals.session = sessionData?.session ?? null;

	// Mounts the Better Auth handler at /api/auth/* and passes everything else through.
	return svelteKitHandler({ event, resolve, auth, building });
};
